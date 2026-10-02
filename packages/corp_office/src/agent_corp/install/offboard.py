"""``ac offboard``: take this machine's office away again, leaving the company's history where it is safe."""

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from agent_corp.auth.devices import DeviceRefused, remove_device
from agent_corp.auth.identity import Identity, identity_path, read_identity
from agent_corp.company.git import CompanyGit, CompanyGitError
from agent_corp.company.loader import load_repo
from agent_corp.daemon.app import OfficePaths
from agent_corp.install import fallback, launchd, service, systemd
from agent_corp.install.launch import REPO, Host, Launch, ServiceError, launch
from agent_corp.install.onboard import CLONE, Prompter, remove_path, user_git

CONFIRM = "Remove all this? (y/N)"

LAUNCHER = Path("packages") / "ac" / "src" / "main.ts"
"""What an ``ac`` launcher runs, relative to the checkout."""


class OffboardError(Exception):
    """Offboarding stopped; the message says why and what was left."""


class Declined(OffboardError):
    """The answer to whether to remove it all was no."""


@dataclass
class Plan:
    """What offboarding found at a home: what it will remove, and whether the company repo goes too."""

    me: Identity | None
    listed: bool
    service: list[str]
    state: list[Path]
    company: Path | None
    keep_why: str | None
    lines: list[str] = field(default_factory=list)


def _git(repo: Path, *args: str) -> tuple[int, str]:
    done = user_git("-C", str(repo), *args)
    return done.returncode, done.stdout


def _ours(me: Identity | None) -> set[str]:
    """The subjects of this device's own commits, which removing the device makes moot."""
    if me is None:
        return set()
    return {f"devices(@{me.handle}): {verb} {me.device}" for verb in ("add", "remove")}


def unpushed(repo: Path, ours: set[str] = frozenset()) -> str | None:
    """Why the company repo at ``repo`` holds work found nowhere else, or None if all of it is pushed.

    Only what git already knows of its remotes counts (nothing is fetched). Commits whose
    subject is in ``ours`` are left out.
    """
    code, out = _git(repo, "rev-parse", "--verify", "-q", "HEAD")
    if code != 0:
        return "it has no commits"
    if not _git(repo, "remote")[1].strip():
        return "it has no remote, so this is its only copy"
    if _git(repo, "status", "--porcelain", "--untracked-files=all")[1].strip():
        return "it has uncommitted changes"
    if _git(repo, "stash", "list")[1].strip():
        return "it has stashed changes"
    for line in _git(repo, "for-each-ref", "--format=%(refname:short) %(upstream)", "refs/heads")[1].splitlines():
        branch, _, upstream = line.partition(" ")
        if not upstream:
            return f"its branch {branch} isn't pushed anywhere"
    code, out = _git(repo, "log", "--format=%s", "--branches", "--not", "--remotes")
    if code != 0:
        return "git can't tell what is pushed"
    count = sum(1 for subject in out.splitlines() if subject not in ours)
    if count:
        return f"it has {count} commit{'s' if count != 1 else ''} not pushed to its remote"
    return None


def _listed(company: Path, me: Identity | None) -> bool:
    if me is None or not (company / "company.yaml").is_file():
        return False
    person = load_repo(company).people.get(me.handle)
    return person is not None and any(d.name == me.device for d in person.devices)


def _service(run: Launch, host: Host, running: bool) -> list[str]:
    found = []
    mode = service.recorded_mode(run)
    files = [p for p in (launchd.plist_path(run, host), systemd.unit_path(run, host)) if p.exists()]
    if mode or files:
        found.append(f"the office's {mode or 'leftover'} service" + (f" ({', '.join(map(str, files))})" if files
                                                                       else ""))
    if running or fallback.daemon(run):
        found.append(f"the running office (pid {service.pid(run)})")
    return found


def plan(home: Path, host: Host, *, delete_company: bool = False, repo: Path = REPO,
         environ: Mapping[str, str] = os.environ) -> tuple[Launch, OfficePaths, Plan]:
    """Look at ``home`` and say what offboarding would remove; nothing is changed."""
    run = launch(home, repo=repo, environ=environ, user_home=host.user_home)
    paths = OfficePaths(run.home)
    me = read_identity(identity_path(paths.home))
    running = host.answers(run.socket)
    listed = _listed(paths.company, me)
    state = [p for p in (paths.office, identity_path(paths.home), paths.home / "tui", paths.home / CLONE)
             if p.exists() or p.is_symlink()]
    company = paths.company if paths.company.exists() or paths.company.is_symlink() else None
    keep_why = None
    if company is not None:
        keep_why = "it isn't a git repo" if not (company / ".git").exists() else unpushed(company, _ours(me))
    found = Plan(me, listed, _service(run, host, running), state, company, keep_why)
    lines = []
    if listed:
        lines.append(f"this device ({me.device}) from @{me.handle} in the company repo")
    lines += found.service
    described = {paths.office: "the office's store, provider.json, logs, and worktrees",
                 identity_path(paths.home): "this device's identity and token", paths.home / "tui": "ac's own state",
                 paths.home / CLONE: "an unfinished clone of a company"}
    lines += [f"{p} ({described[p]})" for p in state]
    if company is not None and keep_why is None:
        lines.append(f"the company repo at {company} (everything in it is pushed)")
    elif company is not None and delete_company:
        lines.append(f"the company repo at {company}, even though {keep_why}")
    found.lines = lines
    return run, paths, found


def _remove_online(run: Launch, me: Identity) -> bool:
    """Remove this device through the running office, with its own token; whether the office took it."""
    try:
        with httpx.Client(transport=httpx.HTTPTransport(uds=str(run.socket)), base_url="http://office",
                          timeout=30) as client:
            done = client.delete(f"/people/{me.handle}/devices/{me.device}", headers=me.headers())
    except httpx.HTTPError:
        return False
    return done.status_code == 200


def _remove_offline(paths: OfficePaths, me: Identity) -> str:
    try:
        remove_device(CompanyGit(paths.company, paths.worktrees), me.handle, me.device, me.handle)
    except DeviceRefused as exc:
        if exc.status == 404:
            return f"This device ({me.device}) was already gone from @{me.handle}."
        return f"Warning: couldn't remove this device from @{me.handle}: {exc.message}."
    except (CompanyGitError, OSError) as exc:
        return f"Warning: couldn't remove this device from @{me.handle}: {exc}."
    return f"Removed this device ({me.device}) from @{me.handle} in the company repo."


def launchers(environ: Mapping[str, str], repo: Path) -> list[Path]:
    """The ``ac`` files on ``PATH`` that run this checkout's ``ac``: links into it, or scripts naming its entry."""
    found: list[Path] = []
    entry = repo / LAUNCHER
    for folder in environ.get("PATH", "").split(os.pathsep):
        if not folder:
            continue
        path = Path(folder) / "ac"
        try:
            if path.is_symlink():
                target = Path(os.path.realpath(path))
                ours = target.is_relative_to(os.path.realpath(repo))
            elif path.is_file() and path.stat().st_size < 4096:
                text = path.read_bytes().decode(errors="replace")
                ours = str(entry) in text or str(Path(os.path.realpath(repo)) / LAUNCHER) in text
            else:
                ours = False
        except OSError:
            ours = False
        if ours and path not in found:
            found.append(path)
    return found


def _report_launchers(prompter: Prompter, environ: Mapping[str, str], repo: Path) -> None:
    found = launchers(environ, repo)
    if not found:
        prompter.say(f"No `ac` launcher from {repo} is on your PATH.")
    for path in found:
        how = "a link made by `bun link`" if path.is_symlink() else "a wrapper script"
        prompter.say(f"`ac` is on your PATH as {path}, {how}; remove it with `rm {path}`.")
    prompter.say(f"The checkout at {repo} stays; delete it yourself once you're done with agent-corp.")


def offboard(home: Path, prompter: Prompter, *, yes: bool = False, delete_company: bool = False,
             host: Host | None = None, repo: Path = REPO, environ: Mapping[str, str] = os.environ) -> None:
    """Remove this machine's office at ``home``, after saying what goes and asking (unless ``yes``).

    In order: this device from its human in the company repo (through the office while it
    runs, otherwise by a local commit once it's stopped); the office and its service; the
    office state, ``identity.json``, and ``tui/``; the company repo, only if all of it is
    pushed (or ``delete_company``); and ``home`` itself once empty. Running it again, or on a
    half-made office, removes only what's there.

    Raises:
        OffboardError: the answer was no, or the office wouldn't stop (only the device is gone then).
    """
    host = host or Host()
    run, paths, found = plan(home, host, delete_company=delete_company, repo=repo, environ=environ)
    keep = found.company is not None and found.keep_why is not None and not delete_company
    keeping = (f"Keeping the company repo at {found.company}: {found.keep_why}. Pass --delete-company to delete"
               " it anyway.") if keep else None
    if not found.lines:
        prompter.say(f"Nothing of this office to remove at {paths.home}.")
        if keeping:
            prompter.say(keeping)
        _report_launchers(prompter, environ, repo)
        return
    prompter.say(f"Offboarding removes this office at {paths.home}:")
    for line in found.lines:
        prompter.say(f"  - {line}")
    if keeping:
        prompter.say(keeping)
    if not yes and prompter.ask(CONFIRM).strip().lower() not in ("y", "yes"):
        raise Declined("nothing was removed")

    me = found.me
    removed_online = False
    if found.listed and me is not None and host.answers(run.socket):
        removed_online = _remove_online(run, me)
        if removed_online:
            prompter.say(f"Removed this device ({me.device}) from @{me.handle} through the office.")
    try:
        for line in service.uninstall(run, host):
            prompter.say(f"Stopped: {line}")
    except ServiceError as exc:
        raise OffboardError(f"{exc}; nothing else was removed") from None
    if found.listed and me is not None and not removed_online:
        prompter.say(_remove_offline(paths, me))

    for path in found.state:
        remove_path(path)
        prompter.say(f"Removed {path}")

    if found.company is not None:
        # Checked again: the office, or the device's removal, may have committed since.
        why = "it isn't a git repo" if not (found.company / ".git").exists() else unpushed(found.company,
                                                                                            _ours(me))
        if why is None or delete_company:
            remove_path(found.company)
            prompter.say(f"Removed the company repo at {found.company}")
        else:
            user_git("-C", str(found.company), "worktree", "prune")
            prompter.say(f"Kept the company repo at {found.company}: {why}.")
    try:
        paths.home.rmdir()
        prompter.say(f"Removed {paths.home}, now empty")
    except OSError:
        pass
    _report_launchers(prompter, environ, repo)

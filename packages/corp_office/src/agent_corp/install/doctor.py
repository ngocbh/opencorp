"""``ac doctor``: check the office home (there and private), company repo, provider, service, daemon, and sandbox."""

import os
import stat
import tempfile
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import psutil

from agent_corp.chat.provider import ProviderError, load_provider
from agent_corp.company.lint import lint
from agent_corp.company.loader import load_repo
from agent_corp.company_template import missing_files
from agent_corp.daemon.app import OfficePaths
from agent_corp.install import launchd, service, systemd
from agent_corp.install.launch import REPO, Host, Launch, launch
from agent_corp.install.onboard import OnboardError, check_provider, stop_to_top_up

_START_ERROR = "agent-corp office: "
"""How the daemon prefixes the one line it prints when it can't start."""


@dataclass(frozen=True)
class Check:
    """One line of the report: ``fail`` needs fixing, ``warn`` is worth knowing."""

    name: str
    status: Literal["ok", "warn", "fail"]
    detail: str


def sandbox_problem() -> str | None:
    """Why a sandboxed command can't run here, or None if one does."""
    from agent_corp.sandbox.policy import SandboxPolicy
    from agent_corp.sandbox.run import run

    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "ws").mkdir()
        (Path(tmp) / "tmp").mkdir()
        try:
            result = run(SandboxPolicy(Path(tmp) / "ws", False, False, Path(tmp) / "tmp"),
                         ["/bin/sh", "-c", "exit 0"], timeout=30)
        except (OSError, RuntimeError, ValueError) as exc:
            return str(exc)
        return None if result.exit == 0 else result.stderr.decode(errors="replace").strip() or f"exit {result.exit}"


def _home(paths: OfficePaths) -> Check:
    try:
        st = os.stat(paths.home)
    except FileNotFoundError:
        return Check("home", "fail", f"no office home at {paths.home}; run `ac onboard`")
    except OSError as exc:
        return Check("home", "fail", f"can't read {paths.home}: {exc.strerror}")
    if not stat.S_ISDIR(st.st_mode):
        return Check("home", "fail", f"{paths.home} is not a directory")
    if (mode := stat.S_IMODE(st.st_mode)) != 0o700:
        return Check("home", "warn", f"{paths.home} is mode {mode:04o}, not 0700; `ac onboard` makes it private")
    return Check("home", "ok", str(paths.home))


def _company(paths: OfficePaths, running: bool) -> Check:
    if not (paths.company / ".git").exists():
        return Check("company", "fail", f"no company repo at {paths.company}; run `ac onboard`")
    try:
        issues = lint(load_repo(paths.company))
    except Exception as exc:  # a repo that won't even load is the finding
        return Check("company", "fail", f"{paths.company} doesn't load: {exc}")
    errors = [i for i in issues if i.severity == "error"]
    if errors:
        return Check("company", "fail", "; ".join(f"{i.path}: {i.code}: {i.message}" for i in errors))
    notes = [f"{len(issues)} lint warnings"] if issues else []
    if missing := missing_files(paths.company):
        todo = stop_to_top_up(len(missing)) if running else "`ac onboard` adds them"
        notes.append(f"missing {', '.join(missing)} from the template; {todo}")
    return Check("company", "warn" if notes else "ok", f"{paths.company}" + (f" ({'; '.join(notes)})" if notes else ""))


def _provider(paths: OfficePaths) -> Check:
    path = paths.office / "provider.json"
    if not os.path.lexists(path):
        return Check("provider", "warn", f"no {path}; runs use composer's defaults. `ac onboard` asks for one")
    try:
        provider = check_provider(load_provider(path).model_dump(exclude_defaults=True))
    except ProviderError as exc:
        return Check("provider", "fail", str(exc))
    except OnboardError as exc:
        return Check("provider", "fail", f"{path}: {exc}")
    llm = provider.llm_config or {}
    login = "key saved" if "api_key" in llm else "composer's own login"
    return Check("provider", "ok", f"{llm.get('provider') or 'default provider'}, {login}")


def _linger(host: Host) -> bool | None:
    """Whether systemd keeps this user's services running after logout; None if ``loginctl`` can't say."""
    done = host.run(["loginctl", "show-user", str(host.uid), "--property=Linger"])
    if done.returncode != 0:
        return None
    return done.stdout.strip() == "Linger=yes"


def _service(run: Launch, host: Host) -> Check:
    mode = service.recorded_mode(run)
    if mode == "launchd":
        name = launchd.label(run)
        if (problem := launchd.not_loaded(run, host)) is None:
            return Check("service", "ok", f"launchd: {name} is loaded")
        return Check("service", "fail", f"launchd: {name} is not loaded ({problem}); run `ac onboard`")
    if mode == "systemd":
        name = systemd.unit_name(run)
        if (problem := systemd.not_enabled(run, host)) is not None:
            return Check("service", "fail", f"systemd: {name} is not enabled ({problem}); run `ac onboard`")
        if _linger(host) is False:
            return Check("service", "warn", f"systemd: {name} is enabled, but stops when you log out;"
                                            " `loginctl enable-linger` keeps it running")
        return Check("service", "ok", f"systemd: {name} is enabled")
    if mode is None:
        return Check("service", "warn", "not installed; run `ac onboard`")
    return Check("service", "warn", f"{mode}: no service manager, so the office won't start again after a reboot")


def _next_step(run: Launch, host: Host) -> str:
    """What to do about an office that isn't answering: ``ac start``, and where its service's status is."""
    mode = service.recorded_mode(run)
    if mode == "launchd":
        name = launchd.label(run)
        return f"Run `ac start`. launchd runs it as {name}: `launchctl print gui/{host.uid}/{name}` shows its status."
    if mode == "systemd":
        name = systemd.unit_name(run)
        return f"Run `ac start`. systemd runs it as {name}: `systemctl --user status {name}` shows its status."
    return "Run `ac start`."


def _crash(log: Path) -> str | None:
    """The last error in the office log if the daemon's last start failed or crashed, else None."""
    try:
        lines = [line for line in log.read_text(errors="replace").splitlines()[-40:] if line.strip()]
    except OSError:
        return None
    if not lines:
        return None
    last = lines[-1]
    # A duplicate start exits 0 and is no crash.
    if last.startswith(_START_ERROR) and "office already running" not in last:
        return last
    if any(line.startswith("Traceback (most recent call last)") for line in lines):
        return last
    return None


def newest_source(repo: Path) -> float:
    """The newest modification time of the Python the daemon runs (agent-corp and agent-composer)."""
    roots = [repo / "packages" / "corp_office" / "src" / "agent_corp", repo / "packages" / "agent-composer" / "src"]
    return max((p.stat().st_mtime for root in roots for p in root.rglob("*.py")), default=0.0)


def version_check(run: Launch, pid: int, newest: float) -> Check:
    """Whether ``pid`` is this office's daemon and started after its code last changed."""
    try:
        proc = psutil.Process(pid)
        cmdline, started = proc.cmdline(), proc.create_time()
    except psutil.Error as exc:
        return Check("version", "warn", f"can't inspect pid {pid}: {exc}")
    if cmdline[1:] != list(run.argv[1:]):
        return Check("version", "warn", f"pid {pid} is not this office's daemon: {' '.join(cmdline)}")
    if started < newest:
        return Check("version", "warn", "the office started before its code last changed; restart it"
                                        " to run the new code")
    return Check("version", "ok", f"pid {pid} runs the current code")


def checks(home: Path, *, host: Host | None = None, repo: Path = REPO,
           probe: Callable[[], str | None] = sandbox_problem) -> list[Check]:
    """Every check, in the order onboarding sets things up."""
    host = host or Host()
    run = launch(home, repo=repo, user_home=host.user_home)
    paths = OfficePaths(run.home)
    running = host.answers(run.socket)
    found = [_home(paths), _company(paths, running), _provider(paths), _service(run, host)]
    if running:
        pid = (paths.pidfile.read_text().strip() if paths.pidfile.exists() else "")
        found.append(Check("office", "ok", f"answering on {run.socket} (pid {pid or '?'})"))
        if pid.isdecimal():
            found.append(version_check(run, int(pid), newest_source(repo)))
    elif error := _crash(run.log):
        found.append(Check("office", "fail", f"not answering on {run.socket}; its last start failed: {error}"
                                             f" (log: {run.log}). {_next_step(run, host)}"))
    else:
        found.append(Check("office", "warn",
                           f"not answering on {run.socket} (log: {run.log}). {_next_step(run, host)}"))
    problem = probe()
    found.append(Check("sandbox", "fail", problem) if problem else Check("sandbox", "ok", "sandboxed commands run"))
    return found


def exit_code(found: Iterable[Check]) -> int:
    """1 if any check failed, else 0."""
    return 1 if any(c.status == "fail" for c in found) else 0


def report(found: Iterable[Check]) -> str:
    """The checks as aligned lines: status, name, detail."""
    return "".join(f"{c.status:<4}  {c.name:<8}  {c.detail}\n" for c in found)

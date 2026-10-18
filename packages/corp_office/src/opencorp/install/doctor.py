"""``ac doctor``: check the office home (there and private), company repo, provider and connections, service,
daemon, sandbox, and Codex."""

import os
import re
import stat
import subprocess
import tempfile
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import psutil

from opencorp.chat.provider import ProviderError, load_provider
from opencorp.company.lint import lint
from opencorp.company.loader import load_repo
from opencorp.company_template import is_new, missing_files
from opencorp.daemon.app import OfficePaths
from opencorp.harness.codex import CodexMissing, codex_command
from opencorp.install import launchd, service, systemd
from opencorp.install.launch import REPO, Host, Launch, launch
from opencorp.install.onboard import SET_UP, OnboardError, check_provider, stop_to_top_up, with_default_model
from opencorp.worker.spawn import worker_env

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
    from opencorp.sandbox.policy import SandboxPolicy
    from opencorp.sandbox.run import run

    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "ws").mkdir()
        (Path(tmp) / "tmp").mkdir()
        try:
            result = run(SandboxPolicy(Path(tmp) / "ws", False, False, Path(tmp) / "tmp"),
                         ["/bin/sh", "-c", "exit 0"], timeout=30)
        except (OSError, RuntimeError, ValueError) as exc:
            return str(exc)
        return None if result.exit == 0 else result.stderr.decode(errors="replace").strip() or f"exit {result.exit}"


_SIGNED_OUT = "not logged in"
"""How ``codex login status`` starts the line it prints when nobody is signed in, casefolded."""

_LINE_CAP = 200
"""The most of a failed ``codex --version`` or ``codex login status`` the report shows."""


_COLOR = re.compile(r"\x1b\[[0-9;]*m")
"""An ANSI color code, which Codex may print around a line."""


def _lines(output: str) -> list[str]:
    """The non-empty lines of ``output``, stripped and without color codes."""
    return [line for raw in output.splitlines() if (line := _COLOR.sub("", raw).strip())]


def _codex_change_lands(mode: str | None) -> str:
    """How a Codex install or setting made in this shell reaches an office running under ``mode``."""
    # launchd and systemd start the office with the environment `ac onboard` wrote into its service file, which
    # `ac restart` reuses; only a stopped office's onboard writes the file again.
    if mode in ("launchd", "systemd"):
        return "stop the office and run `ac onboard` again from that shell"
    return "`ac restart` from that shell"


def codex_check(env: dict[str, str], environ: Mapping[str, str], mode: str | None = None,
                timeout: float = 30) -> Check:
    """Whether the office can start Codex sessions, in the environment it gives an app-server: the binary on its PATH,
    the version, and the sign-in. Missing, signed out, or a ``login status`` that fails otherwise (shown by the first
    line it printed) is a warning, not a failure: only people with ``codex`` in ``harnesses`` need it. A ``codex`` that
    won't run or doesn't answer within ``timeout`` seconds fails.

    ``environ`` is the office's environment: its ``AGENT_CORP_CODEX_BIN`` picks the binary and its ``CODEX_HOME``
    joins ``env``, as they do for an app-server. ``mode`` is the office's recorded service mode, which decides how a
    fix reaches it."""
    try:
        found = codex_command(env, environ)[0]
    except CodexMissing:
        if override := environ.get("AGENT_CORP_CODEX_BIN"):
            return Check("codex", "warn", f"AGENT_CORP_CODEX_BIN names {override}, which isn't an executable the "
                                          "office can find, so Codex sessions can't start (fix or unset it, then "
                                          f"{_codex_change_lands(mode)})")
        return Check("codex", "warn", "not on the office's PATH, so Codex sessions can't start "
                                      f"(npm install -g @openai/codex, then {_codex_change_lands(mode)})")
    if home := environ.get("CODEX_HOME"):
        env = {**env, "CODEX_HOME": home}
    try:
        version = subprocess.run([found, "--version"], env=env, capture_output=True, text=True, timeout=timeout)
        if version.returncode != 0:
            why = _COLOR.sub("", version.stderr).strip()[:_LINE_CAP] or f"exit {version.returncode}"
            return Check("codex", "fail", f"{found} --version failed: {why}")
        login = subprocess.run([found, "login", "status"], env=env, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        return Check("codex", "fail", f"{found} {' '.join(exc.cmd[1:])} didn't answer in {timeout:g} s")
    except OSError as exc:
        return Check("codex", "fail", f"{found} can't run: {exc.strerror or exc}")
    named = f"{printed} at {found}" if (printed := version.stdout.strip()) else f"{found} (no version printed)"
    if login.returncode != 0:
        lines = _lines(login.stderr + "\n" + login.stdout)
        # Codex says "Not logged in" when signed out, and exits 1 on other errors too (a bad config.toml, say),
        # possibly after a warning line.
        if any(line.casefold().startswith(_SIGNED_OUT) for line in lines):
            return Check("codex", "warn", f"{named} is signed out; run `{found} login`")
        said = next((line for line in lines if line.startswith("Error")), lines[0] if lines else None)
        return Check("codex", "warn", f"{named}: `{found} login status` failed: "
                                      f"{said[:_LINE_CAP] if said else f'exit {login.returncode}'}")
    return Check("codex", "ok", f"{named}, signed in")


def _home(paths: OfficePaths) -> Check:
    try:
        st = os.stat(paths.home)
    except FileNotFoundError:
        return Check("home", "fail", f"no office home at {paths.home}; {SET_UP}")
    except OSError as exc:
        return Check("home", "fail", f"can't read {paths.home}: {exc.strerror}")
    if not stat.S_ISDIR(st.st_mode):
        return Check("home", "fail", f"{paths.home} is not a directory")
    if (mode := stat.S_IMODE(st.st_mode)) != 0o700:
        return Check("home", "warn", f"{paths.home} is mode {mode:04o}, not 0700; `ac onboard` makes it private")
    return Check("home", "ok", str(paths.home))


def _company(paths: OfficePaths, running: bool) -> Check:
    if not (paths.company / ".git").exists():
        return Check("company", "fail", f"no company repo at {paths.company}; {SET_UP}")
    if is_new(paths.company):
        return Check("company", "fail", f"{paths.company} has no company yet (no company.yaml, or no first commit);"
                     " run `ac init` to finish it")
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
        return Check("provider", "warn", f"no {path}; runs use the login `yian auth` saved. `ac onboard` asks for one")
    try:
        provider = check_provider(load_provider(path).model_dump(exclude_defaults=True))
    except ProviderError as exc:
        return Check("provider", "fail", str(exc))
    except OnboardError as exc:
        return Check("provider", "fail", f"{path}: {exc}")
    llm = provider.llm_config or {}
    name = llm.get("provider") or "default provider"
    login = "key saved" if "api_key" in llm else "yian's own login"
    # Yian has no default model, so a key that names none fails every run; onboard saves the provider's default.
    try:
        fixed = with_default_model(provider)
    except OnboardError as exc:
        return Check("provider", "fail", f"{path}: {exc}; run `ac onboard`")
    if fixed != provider:
        return Check("provider", "warn", f"{name}, {login}, but no model, so runs fail;"
                                         f" `ac onboard` saves {(fixed.llm_config or {}).get('model')}")
    return Check("provider", "ok", f"{name}, {login}")


def _connections(paths: OfficePaths) -> Check | None:
    """Whether office/connections and every file in it are private; None when no connection was added."""
    folder = paths.office / "connections"
    try:
        st = os.lstat(folder)
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(st.st_mode):
        return Check("connections", "fail", f"{folder} must be a directory, not a symlink")
    if not stat.S_ISDIR(st.st_mode):
        return Check("connections", "fail", f"{folder} is not a directory")
    if (mode := stat.S_IMODE(st.st_mode)) != 0o700:
        return Check("connections", "fail", f"{folder} is mode {mode:04o}, not 0700")
    try:
        entries = sorted(folder.iterdir())
    except OSError as exc:
        return Check("connections", "fail", f"can't read {folder}: {exc.strerror}")
    loose = []
    for p in entries:
        try:
            m = os.lstat(p).st_mode
        except FileNotFoundError:  # removed while this ran
            continue
        if not stat.S_ISREG(m) or m & 0o077:
            loose.append(p.name)
    if loose:
        return Check("connections", "fail", f"{', '.join(loose)} in {folder} must be private to its owner (mode 0600)")
    return Check("connections", "ok", f"{folder} is private")


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
    """The newest modification time of the Python the daemon runs (agent-corp and yian)."""
    roots = [repo / "packages" / "corp_office" / "src" / "opencorp", repo / "packages" / "yian" / "src"]
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
           probe: Callable[[], str | None] = sandbox_problem,
           codex: Callable[[dict[str, str], Mapping[str, str], str | None], Check] = codex_check) -> list[Check]:
    """Every check, in the order onboarding sets things up."""
    host = host or Host()
    run = launch(home, repo=repo, user_home=host.user_home)
    paths = OfficePaths(run.home)
    running = host.answers(run.socket)
    found = [_home(paths), _company(paths, running), _provider(paths)]
    if (added := _connections(paths)) is not None:
        found.append(added)
    found.append(_service(run, host))
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
    # run.env is the environment an office set up or started from this shell gets, which can differ from the running
    # daemon's (a launchd or systemd office keeps the one `ac onboard` wrote into its service file).
    found.append(codex(worker_env(run.env), run.env, service.recorded_mode(run)))
    return found


def exit_code(found: Iterable[Check]) -> int:
    """1 if any check failed, else 0."""
    return 1 if any(c.status == "fail" for c in found) else 0


def report(found: Iterable[Check]) -> str:
    """The checks as aligned lines: status, name, detail."""
    return "".join(f"{c.status:<4}  {c.name:<11}  {c.detail}\n" for c in found)

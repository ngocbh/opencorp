"""Installing and starting the office under the best service manager that works here.

The mode that worked is recorded in ``office/install.json`` so the office is started the same
way later, and so a running office is never handed to a second manager (two daemons would
fight over the pidfile, and launchd or systemd would restart the loser).
"""

import json
from dataclasses import dataclass, field
from pathlib import Path

from opencorp.install import fallback, launchd, systemd
from opencorp.install.files import write_if_changed
from opencorp.install.launch import Host, Launch, ServiceError

MODES = ("launchd", "systemd", "tmux", "background")
_INSTALL = {"launchd": launchd.install, "systemd": systemd.install,
            "tmux": fallback.start_tmux, "background": fallback.start_background}
_START = {"launchd": launchd.start, "systemd": systemd.start,
          "tmux": fallback.start_tmux, "background": fallback.start_background}
_NOT_MANAGED = {"launchd": launchd.not_loaded, "systemd": systemd.not_enabled}


@dataclass(frozen=True)
class Installed:
    """The mode the office runs under (``None`` if it was already running unmanaged) and why others were skipped."""

    mode: str | None
    notes: list[str] = field(default_factory=list)


def recorded_mode(launch: Launch) -> str | None:
    """The mode ``install`` last recorded for this office, if any."""
    try:
        mode = json.loads((launch.office / "install.json").read_text()).get("mode")
    except (OSError, ValueError, AttributeError):
        return None
    return mode if mode in MODES else None


def _record(launch: Launch, mode: str) -> None:
    write_if_changed(launch.office / "install.json",
                     (json.dumps({"mode": mode, "name": launch.name}, indent=2) + "\n").encode())


def _order(host: Host) -> list[str]:
    native = {"darwin": ["launchd"], "linux": ["systemd"]}.get(host.platform, [])
    return native + (["tmux"] if host.which("tmux") else []) + ["background"]


def pid(launch: Launch) -> str:
    """The pid in the office's pidfile, or ``?`` if there is none."""
    try:
        return (launch.office / "office.pid").read_text().strip() or "?"
    except OSError:
        return "?"


def install(launch: Launch, host: Host, mode: str = "auto") -> Installed:
    """Install the office under ``mode``, or under the first that works when ``mode`` is ``auto``.

    A running office stays under the mode it was recorded with; asking for another raises
    ``ServiceError``, and one started by hand is left alone with nothing installed. A running
    office's launchd or systemd service is only checked, never rewritten: the new file would
    differ with the caller's environment, and loading it would restart the office.

    Raises:
        ServiceError: the chosen mode, or the last one tried, failed.
    """
    recorded = recorded_mode(launch)
    if host.answers(launch.socket):
        if recorded is None:
            return Installed(None, [f"the office is already running (pid {pid(launch)}) but was not started by"
                                    " a service; stop it and run `opencorp onboard` again to install one"])
        if mode not in ("auto", recorded):
            raise ServiceError(f"the office is already running under {recorded}; stop it before moving it to {mode}")
        if recorded in _NOT_MANAGED:
            if (problem := _NOT_MANAGED[recorded](launch, host)) is not None:
                raise ServiceError(f"the office is running, but {recorded} doesn't have its service ({problem});"
                                   " stop the office and run `opencorp onboard` again")
            return Installed(recorded, [])
        if recorded == "background":
            # Nothing to bring up to date, and starting it again would only spawn a daemon that exits.
            return Installed(recorded, [])
        order = [recorded]
    else:
        order = _order(host) if mode == "auto" else [mode]
    notes: list[str] = []
    for candidate in order:
        try:
            _INSTALL[candidate](launch, host)
        except ServiceError as exc:
            if mode != "auto" or candidate == order[-1]:
                raise
            notes.append(f"{candidate}: {exc}")
            continue
        _record(launch, candidate)
        return Installed(candidate, notes)
    raise AssertionError("unreachable: the last candidate either returns or raises")


def start(launch: Launch, host: Host) -> Installed:
    """Start the installed office the way it was installed, falling back to a background process.

    A fallback is recorded, so the record always names what runs the office.
    """
    recorded = recorded_mode(launch)
    notes: list[str] = []
    if recorded is not None and recorded != "background":
        try:
            _START[recorded](launch, host)
            return Installed(recorded, [])
        except ServiceError as exc:
            notes.append(f"{recorded}: {exc}")
    fallback.start_background(launch, host)
    _record(launch, "background")
    return Installed("background", notes)


def _tail(path: Path, lines: int = 20) -> str:
    try:
        return "".join(path.read_text(errors="replace").splitlines(keepends=True)[-lines:])
    except OSError:
        return "(no log)\n"


def wait(launch: Launch, host: Host, timeout: float = 20.0) -> None:
    """Wait up to ``timeout`` seconds for the office to answer; ``ServiceError`` with the log's tail if it doesn't."""
    deadline = host.clock() + timeout
    while True:
        # Each probe gets only the time left, so an office that accepts but hangs can't stretch the wait.
        left = deadline - host.clock()
        if host.answers(launch.socket, timeout=min(2.0, max(left, 0.05))):
            return
        left = deadline - host.clock()
        if left <= 0:
            break
        host.sleep(min(0.1, left))
    raise ServiceError(f"the office did not answer on {launch.socket} within {timeout:g}s;"
                       f" the end of {launch.log}:\n{_tail(launch.log)}")


def uninstall(launch: Launch, host: Host, timeout: float = 15.0) -> list[str]:
    """Stop the office and remove its service, whatever runs it; return what was done, one line each.

    Every manager's file is removed, not just the recorded one's: ``start`` falls back to a
    background process and records that, leaving the old plist or unit behind. A daemon still
    holding the pidfile afterwards (one in the background, or started by hand) gets SIGTERM,
    then SIGKILL after ``timeout`` seconds. The record goes too. Running it again does nothing.

    Raises:
        ServiceError: the office still answers afterwards.
    """
    recorded = recorded_mode(launch)
    done = [launchd.uninstall(launch, host, recorded == "launchd"),
            systemd.uninstall(launch, host, recorded == "systemd")]
    if recorded == "tmux" or host.which("tmux"):
        done.append(fallback.stop_tmux(launch, host))
    if stopped := fallback.stop_process(launch, timeout):
        done.append(f"{recorded or 'started by hand'}: {stopped}")
    (launch.office / "install.json").unlink(missing_ok=True)
    _wait_stopped(launch, host)
    return [line for line in done if line]


def _wait_stopped(launch: Launch, host: Host, timeout: float = 5.0) -> None:
    """Wait up to ``timeout`` seconds for the office to stop answering; ``ServiceError`` if it still does."""
    deadline = host.clock() + timeout
    while host.answers(launch.socket, timeout=1.0):
        if host.clock() >= deadline:
            raise ServiceError(f"the office still answers on {launch.socket} (pid {pid(launch)}); stop it and"
                               " try again")
        host.sleep(0.1)


def restart(launch: Launch, host: Host, timeout: float = 15.0) -> Installed:
    """Stop the office's daemon and start it again the way ``start`` would; a stopped office is just started.

    The daemon gets SIGTERM, then SIGKILL after ``timeout`` seconds. It exits 0 on SIGTERM, so
    neither launchd nor systemd restarts it on its own. A leftover tmux session is killed too,
    since ``start_tmux`` would take it for the running office.

    Raises:
        ServiceError: the office still answers after it was stopped, or it can't be started.
    """
    fallback.stop_process(launch, timeout)
    if recorded_mode(launch) == "tmux":
        fallback.stop_tmux(launch, host)
    _wait_stopped(launch, host)
    return start(launch, host)

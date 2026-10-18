"""Running the office without a service manager: in a detached tmux session, or as a detached process."""

import contextlib
import os
import shlex
import signal
import subprocess
import warnings

import psutil

from agent_corp.daemon.main import make_office_dir
from agent_corp.install.launch import Host, Launch, ServiceError


def session(launch: Launch) -> str:
    return f"agent-corp-{launch.name}"


def shell_command(launch: Launch) -> str:
    """The daemon for tmux's shell: ``env -i`` so tmux's own environment (and any key in it) is dropped.

    Its output goes to the log; its stdin stays on the pane.
    """
    env = [shlex.quote(f"{k}={v}") for k, v in sorted(launch.env.items())]
    argv = [shlex.quote(a) for a in launch.argv]
    # stdin holds the pane's pty open: tmux 2.7 closes a pane once nothing has its pty open, even
    # while its process runs, and the kernel then hangs up the daemon. The daemon never reads stdin,
    # and every child it starts gets its own.
    return f"exec env -i {' '.join(env + argv)} >>{shlex.quote(str(launch.log))} 2>&1"


def start_tmux(launch: Launch, host: Host) -> None:
    """Start the daemon in a detached tmux session unless the session is already there.

    The shell ``exec``s the daemon, so the session lives exactly as long as the daemon does.
    """
    name = session(launch)
    if host.run(["tmux", "has-session", "-t", f"={name}"]).returncode == 0:
        return
    done = host.run(["tmux", "new-session", "-d", "-s", name, "-c", str(launch.cwd), shell_command(launch)])
    if done.returncode != 0:
        raise ServiceError(f"tmux new-session failed: {done.stderr.strip()}")


def start_background(launch: Launch, host: Host) -> None:
    """Start the daemon as a detached process in its own session, its output appended to the log.

    Raises ``OfficeStartError`` for an office dir that isn't ours, and ``ServiceError`` if the
    log can't be opened or the daemon can't be started.
    """
    make_office_dir(launch.office)
    try:
        fd = os.open(launch.log, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    except OSError as exc:
        raise ServiceError(f"can't open the office log {launch.log}: {exc}") from exc
    # The daemon outlives this process by design, so Popen's "still running" warning when the
    # handle is dropped is noise.
    with os.fdopen(fd, "ab") as log, warnings.catch_warnings():
        warnings.simplefilter("ignore", ResourceWarning)
        try:
            host.popen(list(launch.argv), cwd=launch.cwd, env=launch.env, stdin=subprocess.DEVNULL,
                       stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
        except OSError as exc:
            raise ServiceError(f"can't start {launch.argv[0]}: {exc}") from exc


def stop_tmux(launch: Launch, host: Host) -> str | None:
    """Kill the office's tmux session; say what was done, or None if there was no session."""
    name = session(launch)
    if host.run(["tmux", "has-session", "-t", f"={name}"]).returncode != 0:
        return None
    host.run(["tmux", "kill-session", "-t", f"={name}"])
    return f"tmux: killed the session {name}"


def daemon(launch: Launch) -> psutil.Process | None:
    """The process in the office's pidfile, if it is this office's daemon (and not a reused pid)."""
    try:
        proc = psutil.Process(int((launch.office / "office.pid").read_text().strip()))
        # argv[0] is left out: the venv's python can show up as the interpreter it links to.
        return proc if proc.cmdline()[1:] == list(launch.argv[1:]) else None
    except (OSError, ValueError, psutil.Error):
        return None


def stop_process(launch: Launch, timeout: float = 15.0) -> str | None:
    """Stop the office's daemon with SIGTERM, then SIGKILL after ``timeout`` seconds; None if none runs."""
    proc = daemon(launch)
    if proc is None:
        return None
    with contextlib.suppress(psutil.Error):
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout)
        except psutil.TimeoutExpired:
            proc.kill()
            proc.wait(5)
    return f"stopped the office (pid {proc.pid})"

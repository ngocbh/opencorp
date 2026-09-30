"""Running the office without a service manager: in a detached tmux session, or as a detached process."""

import os
import shlex
import subprocess

from agent_corp.daemon.main import make_office_dir
from agent_corp.install.launch import Host, Launch, ServiceError


def session(launch: Launch) -> str:
    return f"agent-corp-{launch.name}"


def shell_command(launch: Launch) -> str:
    """The daemon for tmux's shell: ``env -i`` so tmux's own environment (and any key in it) is dropped."""
    env = [shlex.quote(f"{k}={v}") for k, v in sorted(launch.env.items())]
    argv = [shlex.quote(a) for a in launch.argv]
    return (f"exec env -i {' '.join(env + argv)}"
            f" </dev/null >>{shlex.quote(str(launch.log))} 2>&1")


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
    with os.fdopen(fd, "ab") as log:
        try:
            host.popen(list(launch.argv), cwd=launch.cwd, env=launch.env, stdin=subprocess.DEVNULL,
                       stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
        except OSError as exc:
            raise ServiceError(f"can't start {launch.argv[0]}: {exc}") from exc

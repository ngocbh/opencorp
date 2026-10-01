"""The office as a macOS launch agent: a plist in ``~/Library/LaunchAgents`` loaded with ``launchctl``."""

import plistlib
from pathlib import Path

from agent_corp.install.files import write_if_changed
from agent_corp.install.launch import Host, Launch, ServiceError

# ``launchctl bootstrap`` straight after ``bootout`` can fail with EIO while launchd is
# still tearing the old job down; a few short retries cover it.
BOOTSTRAP_TRIES = 3

# What ``launchctl bootstrap`` exits with when it keeps failing with EIO, as it does
# for a ``gui/<uid>`` domain from a session outside the GUI login.
EIO = 5


def label(launch: Launch) -> str:
    return f"com.agent-corp.{launch.name}"


def plist_path(launch: Launch, host: Host) -> Path:
    return host.user_home / "Library" / "LaunchAgents" / f"{label(launch)}.plist"


def plist(launch: Launch) -> bytes:
    """The launch agent: the daemon, restarted only when it fails (at most every 10 s), output appended to the log."""
    return plistlib.dumps({
        "Label": label(launch),
        "ProgramArguments": list(launch.argv),
        "WorkingDirectory": str(launch.cwd),
        "EnvironmentVariables": launch.env,
        "StandardOutPath": str(launch.log),
        "StandardErrorPath": str(launch.log),
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 10,
    })


def not_loaded(launch: Launch, host: Host) -> str | None:
    """Why launchd doesn't have this office's agent loaded, or None if it does."""
    done = host.run(["launchctl", "print", f"gui/{host.uid}/{label(launch)}"])
    return None if done.returncode == 0 else done.stderr.strip() or f"launchctl print exited {done.returncode}"


def install(launch: Launch, host: Host) -> None:
    """Write the plist and load it, or kickstart it if it is already loaded and unchanged.

    Raises ``ServiceError`` if the plist can't be written, or if ``launchctl`` is missing or
    refuses; in the latter case the agent is booted out and its plist removed, so the next
    login doesn't start a service onboarding gave up on.
    """
    path = plist_path(launch, host)
    domain = f"gui/{host.uid}"
    service = f"{domain}/{label(launch)}"
    probe = host.run(["launchctl", "print", service])
    if probe.returncode == 127:
        raise ServiceError(f"launchctl: {probe.stderr.strip()}")
    loaded = probe.returncode == 0
    try:
        changed = write_if_changed(path, plist(launch))
    except OSError as exc:
        raise ServiceError(f"can't write {path}: {exc.strerror or exc}") from None
    if loaded and not changed:
        start(launch, host)
        return
    if loaded:
        host.run(["launchctl", "bootout", service])
    for attempt in range(BOOTSTRAP_TRIES):
        done = host.run(["launchctl", "bootstrap", domain, str(path)])
        if done.returncode == 0:
            return
        host.sleep(0.5 * (attempt + 1))
    path.unlink(missing_ok=True)
    if done.returncode == EIO:
        # launchctl suggests re-running as root, but the agent belongs in the GUI login's session.
        reason = done.stderr.strip().splitlines()[0] if done.stderr.strip() else "Input/output error"
        raise ServiceError(f"launchctl bootstrap {domain} failed: {reason}; this happens outside a GUI login"
                           " (over SSH or in a detached tmux): run `ac onboard` from Terminal in your GUI login,"
                           " or pass `--service tmux`")
    raise ServiceError(f"launchctl bootstrap {domain} failed: {done.stderr.strip()}")


def start(launch: Launch, host: Host) -> None:
    """Start the installed launch agent if it isn't running.

    Raises ``ServiceError`` if ``launchctl kickstart`` refuses; the agent is then booted out
    and its plist removed, so the next login doesn't start a service the caller moved off.
    """
    service = f"gui/{host.uid}/{label(launch)}"
    done = host.run(["launchctl", "kickstart", service])
    if done.returncode != 0:
        host.run(["launchctl", "bootout", service])
        plist_path(launch, host).unlink(missing_ok=True)
        raise ServiceError(f"launchctl kickstart failed: {done.stderr.strip()}")

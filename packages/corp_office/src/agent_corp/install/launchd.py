"""The office as a macOS launch agent: a plist in ``~/Library/LaunchAgents`` loaded with ``launchctl``."""

import plistlib
import subprocess
from pathlib import Path

from agent_corp.install.files import write_if_changed
from agent_corp.install.launch import Host, Launch, ServiceError

# ``launchctl bootstrap`` straight after ``bootout`` can fail with EIO while launchd is
# still tearing the old job down; a few short retries cover it.
BOOTSTRAP_TRIES = 3


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


def install(launch: Launch, host: Host) -> None:
    """Write the plist and load it, or kickstart it if it is already loaded and unchanged.

    Raises ``ServiceError`` if ``launchctl`` is missing or refuses; the plist is then removed
    so the next login doesn't start a service onboarding gave up on.
    """
    path = plist_path(launch, host)
    domain = f"gui/{host.uid}"
    service = f"{domain}/{label(launch)}"
    probe = host.run(["launchctl", "print", service])
    if probe.returncode == 127:
        raise ServiceError(f"launchctl: {probe.stderr.strip()}")
    loaded = probe.returncode == 0
    changed = write_if_changed(path, plist(launch))
    if loaded and not changed:
        _check(host.run(["launchctl", "kickstart", service]), "kickstart")
        return
    if loaded:
        host.run(["launchctl", "bootout", service])
    for attempt in range(BOOTSTRAP_TRIES):
        done = host.run(["launchctl", "bootstrap", domain, str(path)])
        if done.returncode == 0:
            return
        host.sleep(0.5 * (attempt + 1))
    path.unlink(missing_ok=True)
    raise ServiceError(f"launchctl bootstrap {domain} failed: {done.stderr.strip()}")


def start(launch: Launch, host: Host) -> None:
    """Start the installed launch agent if it isn't running."""
    _check(host.run(["launchctl", "kickstart", f"gui/{host.uid}/{label(launch)}"]), "kickstart")


def _check(done: subprocess.CompletedProcess[str], what: str) -> None:
    if done.returncode != 0:
        raise ServiceError(f"launchctl {what} failed: {done.stderr.strip()}")

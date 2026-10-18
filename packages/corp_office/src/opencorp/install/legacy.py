"""What an install from before the rename to OpenCorp left on this machine, and the commands that clear it up.

Nothing here moves or removes anything: ``opencorp doctor`` reports what is left and prints the commands, and the
owner runs them. The old names live only here and in the sandbox's sensitive home paths.
"""

import json
import os
import plistlib
import shlex
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

import psutil

from opencorp.install.launch import Host
from opencorp.install.offboard import launchers

OLD_HOME = ".agent-corp"
NEW_HOME = ".opencorp"
OLD_LABEL = "com.agent-corp."
OLD_UNIT = "agent-corp-"
OLD_SESSION = "agent-corp-"
OLD_ENV = "AGENT_CORP_"
NEW_ENV = "OPENCORP_"
OLD_LAUNCHER = "ac"
NEW_LAUNCHER = "opencorp"
OLD_ENTRY = Path("packages") / "ac" / "src" / "main.ts"
NEW_ENTRY = Path("packages") / "cli" / "src" / "main.ts"


@dataclass(frozen=True)
class Leftovers:
    """What the old install left; each field is empty (or None, or False) when nothing of its kind is left."""

    home: Path | None = None
    both: bool = False
    """``~/.opencorp`` exists too, so the old home can't just be moved."""
    plists: tuple[Path, ...] = ()
    units: tuple[Path, ...] = ()
    sessions: tuple[str, ...] = ()
    pid: int | None = None
    """A daemon still running from the old home with no service around it."""
    env: tuple[str, ...] = ()
    launchers: tuple[Path, ...] = ()
    default: bool = False
    """The office at the old default home needs setting up again: its home, or a service or daemon for it, is left."""
    elsewhere: tuple[Path, ...] = ()
    """Other homes an old launchd job or systemd unit ran an office for, which still exist."""
    on_path: bool = False
    """An ``opencorp`` launcher for this checkout is already on ``PATH``."""

    def __bool__(self) -> bool:
        return any((self.home, self.plists, self.units, self.sessions, self.pid, self.env, self.launchers))

    def summary(self) -> str:
        """One line for the doctor's report."""
        found = [f"the old home {self.home}"] if self.home else []
        found += [f"launchd job {p.stem}" for p in self.plists]
        found += [f"systemd unit {p.name}" for p in self.units]
        found += [f"tmux session {s}" for s in self.sessions]
        found += [f"an office running from the old home (pid {self.pid})"] if self.pid else []
        found += [f"${name}" for name in self.env]
        found += [f"the `{OLD_LAUNCHER}` launcher {p}" for p in self.launchers]
        return f"from before the rename to OpenCorp: {', '.join(found)}; what to run is below the report"


def _recorded(home: Path) -> tuple[str | None, str]:
    """The service mode and name the old home's ``office/install.json`` recorded."""
    try:
        record = json.loads((home / "office" / "install.json").read_text())
        return record.get("mode"), record.get("name") or "office"
    except (OSError, ValueError, AttributeError):
        return None, "office"


def _running(home: Path) -> int | None:
    """The pid in the old home's pidfile, if that process is a daemon for that home."""
    try:
        proc = psutil.Process(int((home / "office" / "office.pid").read_text().strip()))
        return proc.pid if os.path.realpath(home) in proc.cmdline() else None
    except (OSError, ValueError, psutil.Error):
        return None


def _service_home(path: Path) -> Path | None:
    """The ``--home`` an old launchd plist or systemd unit started the daemon with, or None if it can't be read."""
    try:
        if path.suffix == ".plist":
            argv = plistlib.loads(path.read_bytes())["ProgramArguments"]
        else:
            line = next(x for x in path.read_text().splitlines() if x.startswith("ExecStart="))
            # Undo the unit's escapes: `$` and `%` were doubled, and words were quoted shell-style.
            argv = [a.replace("$$", "$").replace("%%", "%") for a in shlex.split(line.removeprefix("ExecStart="))]
        return Path(argv[argv.index("--home") + 1])
    except (OSError, ValueError, KeyError, IndexError, TypeError, AttributeError, StopIteration):
        return None


def find(host: Host, environ: Mapping[str, str], repo: Path) -> Leftovers:
    """Look for the old home, its launchd, systemd and tmux jobs, old env vars, and an ``ac`` launcher for ``repo``."""
    old = host.user_home / OLD_HOME
    home = old if old.is_dir() else None
    plists = tuple(sorted((host.user_home / "Library" / "LaunchAgents").glob(f"{OLD_LABEL}*.plist")))
    units = tuple(sorted((host.user_home / ".config" / "systemd" / "user").glob(f"{OLD_UNIT}*.service")))
    homes = [_service_home(p) for p in plists + units]
    others = [h for h in homes if h is not None and os.path.realpath(h) != os.path.realpath(old)]
    sessions: tuple[str, ...] = ()
    pid = None
    if home is not None:
        mode, name = _recorded(home)
        session = f"{OLD_SESSION}{name}"
        # Only a home that recorded tmux is asked about, so a doctor run never starts tmux for nothing.
        if mode == "tmux" and host.run(["tmux", "has-session", "-t", f"={session}"]).returncode == 0:
            sessions = (session,)
        if not (plists or units or sessions):
            pid = _running(home)
    return Leftovers(
        home=home, both=home is not None and (host.user_home / NEW_HOME).exists(), plists=plists, units=units,
        sessions=sessions, pid=pid, env=tuple(sorted(k for k in environ if k.startswith(OLD_ENV))),
        launchers=tuple(launchers(environ, repo, name=OLD_LAUNCHER, entry=OLD_ENTRY)),
        # A service whose --home can't be read is taken to be the default office's.
        default=home is not None or len(others) < len(homes),
        elsewhere=tuple(sorted({h for h in others if h.is_dir()})),
        # Only this checkout's launcher counts: another `opencorp` on PATH may run a different checkout.
        on_path=bool(launchers(environ, repo)))


def old_home_only(user_home: Path) -> Path | None:
    """``~/.agent-corp`` when it exists and ``~/.opencorp`` doesn't, else None."""
    old = user_home / OLD_HOME
    return old if old.is_dir() and not (user_home / NEW_HOME).exists() else None

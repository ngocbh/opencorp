"""Who else uses this host: on such a host, whoever holds HQ's TCP port while the office doesn't is the origin the
browser trusts."""

import getpass
import sys
from pathlib import Path

import psutil

_NOT_PEOPLE = {"Shared", "Guest"}


def other_users(platform: str = sys.platform, *, users_dir: Path = Path("/Users"), me: str | None = None) -> list[str]:
    """Other accounts: on macOS, the folders under /Users; elsewhere, the users logged in now."""
    me = me or getpass.getuser()
    if platform == "darwin":
        try:
            names = {p.name for p in users_dir.iterdir() if p.is_dir() and not p.name.startswith(".")}
        except OSError:
            return []
        return sorted(names - _NOT_PEOPLE - {me})
    return sorted({u.name for u in psutil.users()} - {me})

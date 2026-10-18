"""Find and kill macOS processes that left a sandboxed call's process group.

A sandboxed process can `setsid()` into a new session, so killing the call's process
group misses it; macOS has no pid namespace to fall back on. It still carries the call's
Seatbelt profile, though, and `sandbox_check` can ask any process's profile whether it may
write a path. Each call's profile gets a write rule for its own canary directory, so a
process that may write that directory, but not a sibling one next to it, runs under
this call's profile and nothing else's.
"""

from __future__ import annotations

import ctypes
import functools
import os
import shutil
import signal
import tempfile
from collections.abc import Callable
from pathlib import Path

import psutil

# Enough rounds to stop a process tree that forks while it is being stopped.
_MAX_ROUNDS = 50
_SANDBOX_FILTER_NONE = 0
_SANDBOX_FILTER_PATH = 1


class Canary:
    """Two new directories: `allowed`, which only this call's profile may write, and `denied`.

    Both must exist, because `sandbox_check` reports a missing path as denied. `denied`
    tells this call's profile apart from ones that allow writes broadly (several system
    agents' do), which would allow both.

    Args:
        avoid: Directories the call may write; the canary is created outside them, since
            under one of them `denied` would be writable too.
    """

    def __init__(self, avoid: tuple[Path, ...] = ()) -> None:
        roots = [Path(os.path.realpath(tempfile.gettempdir())), Path("/private/tmp"), Path("/private/var/tmp")]
        root = next((r for r in roots if not any(r.is_relative_to(a) for a in avoid)), roots[0])
        self.root = Path(tempfile.mkdtemp(prefix="opencorp-call-", dir=root))
        self.allowed = self.root / "allowed"
        self.denied = self.root / "denied"
        self.allowed.mkdir()
        self.denied.mkdir()

    def close(self) -> None:
        """Remove the directories."""
        shutil.rmtree(self.root, ignore_errors=True)


def kill_escaped(canary: Canary) -> list[int]:
    """SIGKILL every process running under the profile that allows writing `canary.allowed`.

    Matching processes are stopped first, round by round, until a round finds no new
    ones, so a process can't fork a survivor between the scan and the kill.

    Returns:
        The pids that were killed.
    """
    check, path_filter = _sandbox_check()
    allowed = ctypes.c_char_p(os.fsencode(canary.allowed))
    denied = ctypes.c_char_p(os.fsencode(canary.denied))

    def in_call(pid: int) -> bool:
        # sandbox_check returns 0 for allowed, 1 for denied (and for an unsandboxed
        # process's "is it sandboxed" query, 0), -1 on error.
        return (
            check(pid, None, _SANDBOX_FILTER_NONE) == 1
            and check(pid, b"file-write-data", path_filter, allowed) == 0
            and check(pid, b"file-write-data", path_filter, denied) == 1
        )

    me = os.getpid()
    found: list[int] = []
    for _ in range(_MAX_ROUNDS):
        new = [pid for pid in psutil.pids() if pid != me and pid not in found and in_call(pid)]
        if not new:
            break
        for pid in new:
            _signal(pid, signal.SIGSTOP)
        found += new
    for pid in found:
        _signal(pid, signal.SIGKILL)
    return found


def _signal(pid: int, sig: signal.Signals) -> None:
    try:
        os.kill(pid, sig)
    except (ProcessLookupError, PermissionError):
        pass


@functools.cache
def _sandbox_check() -> tuple[Callable[..., int], int]:
    """Return libsystem_sandbox's `sandbox_check` and the path filter type to pass it."""
    lib = ctypes.CDLL("/usr/lib/system/libsystem_sandbox.dylib")
    check = lib.sandbox_check
    # int sandbox_check(pid_t, const char *operation, int filter_type, ...). Only the
    # fixed arguments are declared, so ctypes passes the path as a variadic argument,
    # which arm64 puts on the stack rather than in a register.
    check.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    check.restype = ctypes.c_int
    try:
        # Keeps the denied checks out of the system log.
        no_report = ctypes.c_int.in_dll(lib, "SANDBOX_CHECK_NO_REPORT").value
    except ValueError:
        no_report = 0
    return check, _SANDBOX_FILTER_PATH | no_report

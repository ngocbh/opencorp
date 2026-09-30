"""Run one command in the sandbox, in its own process group."""

from __future__ import annotations

import os
import select
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import IO

from agent_corp.sandbox import bwrap, escapees, seatbelt
from agent_corp.sandbox.policy import SandboxPolicy

SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"
_POLL = 0.05
_READER_GRACE = 2.0


class SandboxUnavailable(RuntimeError):
    """This platform has no supported sandbox."""


@dataclass(frozen=True)
class Result:
    """The outcome of one sandboxed call.

    `exit` is the exit status (negative for a signal), or `None` when the call was killed
    for its timeout or by `cancel`.
    """

    exit: int | None
    stdout: bytes
    stderr: bytes
    timed_out: bool
    interrupted: bool
    truncated: bool
    duration: float


def scrubbed_env(policy: SandboxPolicy) -> dict[str, str]:
    """Return the whole environment of a sandboxed call; nothing is inherited."""
    return {
        "PATH": SAFE_PATH,
        "HOME": str(policy.tmpdir),
        "TMPDIR": str(policy.tmpdir),
        "LANG": "en_US.UTF-8",
        "TERM": "dumb",
        # The host's /etc/gitconfig is unreadable in the sandbox, and git treats that as fatal.
        "GIT_CONFIG_NOSYSTEM": "1",
    }


def command(policy: SandboxPolicy, argv: list[str], canary: Path | None = None) -> list[str]:
    """Return the host argv that runs `argv` under `policy` on this platform.

    `canary` marks the call's processes on macOS (see `sandbox.escapees`).

    Raises:
        SandboxUnavailable: The platform is neither macOS nor Linux.
    """
    if sys.platform == "darwin":
        return ["/usr/bin/sandbox-exec", "-p", seatbelt.profile(policy, canary), *argv]
    if sys.platform.startswith("linux"):
        return bwrap.command(policy, argv)
    raise SandboxUnavailable(f"no sandbox for platform {sys.platform!r}")


def run(
    policy: SandboxPolicy,
    argv: list[str],
    stdin: bytes | None = None,
    timeout: float = 120.0,
    *,
    cancel: threading.Event | None = None,
    max_output: int = 1 << 20,
) -> Result:
    """Run `argv` in the sandbox, in the workspace, with a scrubbed environment.

    The call runs in a new process group. The group is killed when the call's first
    process exits (so nothing it started in the background survives), when `timeout`
    seconds pass, when `cancel` is set, or when this function is interrupted. On macOS,
    processes that left the group with `setsid` are then found and killed too; on
    Linux the pid namespace dies with the call.
    Each output stream keeps at most `max_output` bytes.
    """
    start = time.monotonic()
    canary = None
    if sys.platform == "darwin":
        canary = escapees.Canary(avoid=(policy.tmpdir, *([policy.workspace] if policy.writable else [])))
    try:
        return _run(policy, argv, stdin, timeout, cancel, max_output, canary, start)
    finally:
        if canary is not None:
            canary.close()


def _run(
    policy: SandboxPolicy,
    argv: list[str],
    stdin: bytes | None,
    timeout: float,
    cancel: threading.Event | None,
    max_output: int,
    canary: escapees.Canary | None,
    start: float,
) -> Result:
    proc = subprocess.Popen(
        command(policy, argv, canary.allowed if canary else None),
        cwd=policy.workspace,
        env=scrubbed_env(policy),
        stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    assert proc.stdout is not None and proc.stderr is not None
    out, err = _Capture(proc.stdout, max_output), _Capture(proc.stderr, max_output)
    out.start()
    err.start()
    if stdin is not None:
        assert proc.stdin is not None
        threading.Thread(target=_feed, args=(proc.stdin, stdin), daemon=True).start()
    timed_out = interrupted = False
    watch = _ExitWatch(proc.pid)
    try:
        while not watch.wait(_POLL):
            if cancel is not None and cancel.is_set():
                interrupted = True
                break
            if time.monotonic() - start >= timeout:
                timed_out = True
                break
    finally:
        try:
            # The leader is not reaped yet, so its pid (the group id) can't have been reused.
            _kill_group(proc.pid)
            if canary is not None:
                escapees.kill_escaped(canary)
        finally:
            watch.close()
            proc.wait()
    # Every writer should be dead now, but an escapee that wasn't found could still hold
    # the pipes; don't wait on it for long.
    deadline = time.monotonic() + _READER_GRACE
    out.join(_READER_GRACE)
    err.join(max(0.0, deadline - time.monotonic()))
    return Result(
        exit=None if timed_out or interrupted else proc.returncode,
        stdout=bytes(out.data),
        stderr=bytes(err.data),
        timed_out=timed_out,
        interrupted=interrupted,
        truncated=out.truncated or err.truncated,
        duration=time.monotonic() - start,
    )


class _ExitWatch:
    """Wait for a child to exit without reaping it."""

    def __init__(self, pid: int) -> None:
        self._pid = pid
        self._exited = False
        self._kq: select.kqueue | None = None
        if not hasattr(os, "waitid"):
            # macOS before Python 3.13 has no waitid; a kqueue exit event doesn't reap.
            self._kq = select.kqueue()
            event = select.kevent(
                pid, select.KQ_FILTER_PROC, select.KQ_EV_ADD | select.KQ_EV_ONESHOT, select.KQ_NOTE_EXIT
            )
            try:
                self._kq.control([event], 0, 0)
            except ProcessLookupError:
                # Registering fails once the child is a zombie.
                self._exited = True

    def wait(self, timeout: float) -> bool:
        """Return whether the child has exited, waiting up to `timeout` seconds."""
        if self._exited:
            return True
        if self._kq is not None:
            self._exited = bool(self._kq.control(None, 1, timeout))
        elif not self._check():
            time.sleep(timeout)
            self._exited = self._check()
        else:
            self._exited = True
        return self._exited

    def _check(self) -> bool:
        return os.waitid(os.P_PID, self._pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None

    def close(self) -> None:
        if self._kq is not None:
            self._kq.close()


def _kill_group(pgid: int) -> None:
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def _feed(stream: IO[bytes], data: bytes) -> None:
    try:
        stream.write(data)
    except BrokenPipeError:
        pass
    finally:
        try:
            stream.close()
        except OSError:
            pass


class _Capture(threading.Thread):
    """Read a stream to EOF, keeping at most `limit` bytes."""

    def __init__(self, stream: IO[bytes], limit: int) -> None:
        super().__init__(daemon=True)
        self._stream = stream
        self._limit = limit
        self.data = bytearray()
        self.truncated = False

    def run(self) -> None:
        fd = self._stream.fileno()
        while chunk := os.read(fd, 65536):
            room = self._limit - len(self.data)
            if len(chunk) > room:
                self.truncated = True
            if room > 0:
                self.data += chunk[:room]
        self._stream.close()

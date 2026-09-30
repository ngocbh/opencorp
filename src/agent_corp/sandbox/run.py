"""Run one command in the sandbox, in its own process group."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from typing import IO

from agent_corp.sandbox import bwrap, seatbelt
from agent_corp.sandbox.policy import SandboxPolicy

SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"
_POLL = 0.05
_READER_GRACE = 5.0


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


def command(policy: SandboxPolicy, argv: list[str]) -> list[str]:
    """Return the host argv that runs `argv` under `policy` on this platform.

    Raises:
        SandboxUnavailable: The platform is neither macOS nor Linux.
    """
    if sys.platform == "darwin":
        return ["/usr/bin/sandbox-exec", "-p", seatbelt.profile(policy), *argv]
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
    seconds pass, when `cancel` is set, or when this function is interrupted.
    Each output stream keeps at most `max_output` bytes.
    """
    start = time.monotonic()
    proc = subprocess.Popen(
        command(policy, argv),
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
    try:
        while True:
            try:
                proc.wait(timeout=_POLL)
                break
            except subprocess.TimeoutExpired:
                pass
            if cancel is not None and cancel.is_set():
                interrupted = True
                break
            if time.monotonic() - start >= timeout:
                timed_out = True
                break
    finally:
        _kill_group(proc.pid)
        proc.wait()
    # A process that left the group could still hold the pipes; don't wait on it forever.
    out.join(_READER_GRACE)
    err.join(_READER_GRACE)
    return Result(
        exit=None if timed_out or interrupted else proc.returncode,
        stdout=bytes(out.data),
        stderr=bytes(err.data),
        timed_out=timed_out,
        interrupted=interrupted,
        truncated=out.truncated or err.truncated,
        duration=time.monotonic() - start,
    )


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

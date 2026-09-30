"""Workspace tools: read, write, edit, list, search, and shell, each one sandboxed call."""

from __future__ import annotations

import inspect
import json
import os
import sys
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from agent_corp.sandbox import fileops
from agent_corp.sandbox.policy import SandboxPolicy
from agent_corp.sandbox.run import Result, run

TOOL_NAMES = ("read_file", "write_file", "edit_file", "list", "search", "shell")
MAX_SHELL_TIMEOUT = 600.0
# Bytes of shell output the model sees; the rest of the capture is cut from the middle.
MAX_SHELL_OUTPUT = 64 * 1024
_BULK_ARGS = frozenset({"content", "old", "new"})
_MAX_ARG_CHARS = 200
_FILEOPS_SOURCE = Path(fileops.__file__).read_text(encoding="utf-8")


@dataclass(frozen=True)
class AuditRecord:
    """What one workspace call did, for the audit log.

    `exit` is the call's exit status, or `None` when it was killed (timeout or
    interrupt); `duration` is in seconds.
    """

    tool: str
    args_summary: str
    exit: int | None
    duration: float


@dataclass(frozen=True)
class ToolOutcome:
    """A workspace call's model-visible output and its audit record."""

    output: str
    audit: AuditRecord


def interpreter() -> tuple[Path, tuple[Path, ...]]:
    """Return the Python binary the file tools run, and the paths it needs to read."""
    exe = Path(os.path.realpath(sys.executable))
    prefix = Path(os.path.realpath(sys.base_prefix))
    paths = (prefix,) if exe.is_relative_to(prefix) else (prefix, exe.parent)
    return exe, paths


class WorkspaceTools:
    """One session's workspace tools; every call runs as its own sandboxed process.

    Args:
        policy: The session's sandbox policy.
        file_timeout: Seconds a file tool may run.
        shell_timeout: Default seconds a shell call may run (the model may ask for up
            to `MAX_SHELL_TIMEOUT`).
    """

    def __init__(self, policy: SandboxPolicy, *, file_timeout: float = 30.0, shell_timeout: float = 120.0) -> None:
        self._python, paths = interpreter()
        self._policy = replace(policy, read_only=(*policy.read_only, *paths))
        self._file_timeout = file_timeout
        self._shell_timeout = shell_timeout
        self._lock = threading.Lock()
        self._active: set[threading.Event] = set()

    @property
    def policy(self) -> SandboxPolicy:
        """Return the policy calls run under, including the interpreter's paths."""
        return self._policy

    def call(self, name: str, args: Mapping[str, Any]) -> ToolOutcome:
        """Run the tool `name` with `args` (the office side of a `tool_call`).

        Missing or unexpected arguments come back as an `error:` outcome that never ran.

        Raises:
            ValueError: `name` is not a workspace tool.
        """
        if name not in TOOL_NAMES:
            raise ValueError(f"unknown workspace tool {name!r}")
        method = getattr(self, "list_dir" if name == "list" else name)
        try:
            inspect.signature(method).bind(**args)
        except TypeError as exc:
            return ToolOutcome(f"error: {name}: {exc}", AuditRecord(name, _summarize(args), None, 0.0))
        return method(**args)

    def interrupt(self) -> None:
        """Kill every call running now; they return `[interrupted]`."""
        with self._lock:
            for event in self._active:
                event.set()

    def read_file(self, path: str, offset: int = 0, limit: int | None = None) -> ToolOutcome:
        """Read a text file."""
        return self._file_op("read_file", path=path, offset=offset, limit=limit)

    def write_file(self, path: str, content: str) -> ToolOutcome:
        """Create or replace a file."""
        return self._file_op("write_file", path=path, content=content)

    def edit_file(self, path: str, old: str, new: str, replace_all: bool = False) -> ToolOutcome:
        """Replace text in a file."""
        return self._file_op("edit_file", path=path, old=old, new=new, replace_all=replace_all)

    def list_dir(self, path: str = ".") -> ToolOutcome:
        """List a directory (the `list` tool)."""
        return self._file_op("list", path=path)

    def search(self, pattern: str, path: str = ".", glob: str | None = None) -> ToolOutcome:
        """Search files for a regex."""
        return self._file_op("search", pattern=pattern, path=path, glob=glob)

    def shell(self, command: str, timeout: float | None = None) -> ToolOutcome:
        """Run a `/bin/sh` command in the workspace."""
        limit = self._shell_timeout if timeout is None else min(max(float(timeout), 1.0), MAX_SHELL_TIMEOUT)
        result = self._run(["/bin/sh", "-c", command], None, limit)
        output = _shell_output(result, limit)
        return ToolOutcome(output, _audit("shell", {"command": command, "timeout": timeout}, result))

    def _file_op(self, tool: str, **args: Any) -> ToolOutcome:
        request = json.dumps({"op": tool, **args}).encode()
        argv = [str(self._python), "-I", "-S", "-c", _FILEOPS_SOURCE]
        result = self._run(argv, request, self._file_timeout)
        if result.timed_out:
            output = f"error: {tool} timed out after {self._file_timeout:g}s"
        elif result.interrupted:
            output = "[interrupted]"
        else:
            output = _file_output(tool, result)
        return ToolOutcome(output, _audit(tool, args, result))

    def _run(self, argv: list[str], stdin: bytes | None, timeout: float) -> Result:
        cancel = threading.Event()
        with self._lock:
            self._active.add(cancel)
        try:
            return run(self._policy, argv, stdin, timeout, cancel=cancel)
        finally:
            with self._lock:
                self._active.discard(cancel)


def _file_output(tool: str, result: Result) -> str:
    # The helper's stdout is untrusted: anything but a well-formed reply is a failure.
    try:
        reply = json.loads(result.stdout)
    except ValueError:
        reply = None
    if isinstance(reply, dict) and reply.get("ok") is True and isinstance(reply.get("output"), str):
        return reply["output"]
    if isinstance(reply, dict) and isinstance(reply.get("error"), str):
        return f"error: {reply['error']}"
    stderr = result.stderr.decode("utf-8", "replace").strip()[-500:]
    return f"error: {tool} failed (exit {result.exit}): {stderr}"


def _shell_output(result: Result, limit: float) -> str:
    data = result.stdout
    if result.stderr:
        data += (b"" if not data or data.endswith(b"\n") else b"\n") + b"[stderr]\n" + result.stderr
    text = _head_and_tail(data, MAX_SHELL_OUTPUT)
    if result.truncated:
        text += ("" if not text or text.endswith("\n") else "\n") + "[output truncated]"
    if result.timed_out:
        status = f"[timed out after {limit:g}s]"
    elif result.interrupted:
        status = "[interrupted]"
    else:
        status = f"[exit {result.exit}]"
    return text + ("" if not text or text.endswith("\n") else "\n") + status


def _head_and_tail(data: bytes, limit: int) -> str:
    """Decode `data`; past `limit` bytes, keep only its first and last `limit // 2` bytes."""
    if len(data) <= limit:
        return data.decode("utf-8", "replace")
    half = limit // 2
    head, tail = data[:half].decode("utf-8", "replace"), data[-half:].decode("utf-8", "replace")
    return f"{head}\n[{len(data) - 2 * half} bytes of output cut]\n{tail}"


def _audit(tool: str, args: Mapping[str, Any], result: Result) -> AuditRecord:
    return AuditRecord(tool, _summarize(args), result.exit, result.duration)


def _summarize(args: Mapping[str, Any]) -> str:
    """Summarize arguments for the audit log; bulk text is recorded by length only."""
    parts = []
    for key, value in args.items():
        if value is None or (key == "offset" and value == 0) or (key == "replace_all" and value is False):
            continue
        if key in _BULK_ARGS and isinstance(value, str):
            parts.append(f"{key}=<{len(value)} chars>")
            continue
        text = repr(value)
        if len(text) > _MAX_ARG_CHARS:
            text = text[: _MAX_ARG_CHARS - 3] + "..."
        parts.append(f"{key}={text}")
    return " ".join(parts)


def workspace_tool_functions(call: Callable[[str, dict[str, Any]], str]) -> dict[str, Callable[..., str]]:
    """Return the model-facing workspace tools, keyed by tool name, for a composer run.

    Each is a plain function whose signature is the tool's schema and whose docstring
    is its description; calling it forwards `(name, args)` to `call` and returns its
    result. Pass the dict as the run's `workspace` tool group.
    """

    def read_file(path: str, offset: int = 0, limit: int | None = None) -> str:
        """Read a text file in the workspace.

        `path` is relative to the workspace. `offset` is the first line to return
        (0-based) and `limit` the number of lines; omit both for the whole file.
        """
        return call("read_file", {"path": path, "offset": offset, "limit": limit})

    def write_file(path: str, content: str) -> str:
        """Create or overwrite a file in the workspace with `content`.

        Parent directories are created. `path` is relative to the workspace.
        """
        return call("write_file", {"path": path, "content": content})

    def edit_file(path: str, old: str, new: str, replace_all: bool = False) -> str:
        """Replace the exact text `old` with `new` in a workspace file.

        `old` must appear exactly once, unless `replace_all` is true; include enough
        surrounding text to make it unique.
        """
        return call("edit_file", {"path": path, "old": old, "new": new, "replace_all": replace_all})

    def list_dir(path: str = ".") -> str:
        """List a workspace directory; subdirectories end with `/`."""
        return call("list", {"path": path})

    def search(pattern: str, path: str = ".", glob: str | None = None) -> str:
        """Search workspace files for a Python regex; returns `file:line:text` lines.

        `path` limits the search to a file or directory. `glob` (such as `*.py`) filters
        file names. `.git` and binary files are skipped.
        """
        return call("search", {"pattern": pattern, "path": path, "glob": glob})

    def shell(command: str, timeout: float | None = None) -> str:
        """Run a `/bin/sh` command in the workspace and return its output and exit status.

        The command runs in a sandbox: only the workspace and a private temp directory
        are available, the network may be off, and anything it starts is stopped when
        it returns. `timeout` is in seconds (default 120, at most 600). Output over
        64 KB keeps only its start and end.
        """
        return call("shell", {"command": command, "timeout": timeout})

    return {
        "read_file": read_file,
        "write_file": write_file,
        "edit_file": edit_file,
        "list": list_dir,
        "search": search,
        "shell": shell,
    }

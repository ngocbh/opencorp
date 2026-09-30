"""Workspace file operations, run inside the sandbox as one process per call.

Reads one JSON request (`{"op": ..., **args}`) on stdin and writes one JSON reply
(`{"ok": true, "output": ...}` or `{"ok": false, "error": ...}`) on stdout. Paths are
relative to the working directory, the workspace. The sandbox, not this code, decides
what may be read or written. It uses only the standard library, because it runs as
`python -I -S`, without site-packages.
"""

import fnmatch
import json
import os
import re
import sys

MAX_READ_CHARS = 200_000
MAX_MATCHES = 200
MAX_LINE_CHARS = 300
MAX_SEARCH_FILE_BYTES = 2_000_000


class OpError(Exception):
    """A request that can't be done; the message goes back to the model."""


def read_file(path, offset=0, limit=None):
    """Return the file's text, from line `offset` (0-based), at most `limit` lines."""
    if offset < 0 or (limit is not None and limit < 0):
        raise OpError("offset and limit must not be negative")
    with open(path, encoding="utf-8", errors="replace", newline="") as f:
        lines = f.read().splitlines(keepends=True)
    text = "".join(lines[offset : None if limit is None else offset + limit])
    if len(text) > MAX_READ_CHARS:
        text = text[:MAX_READ_CHARS] + f"\n[truncated at {MAX_READ_CHARS} characters; use offset and limit]"
    return text


def write_file(path, content):
    """Create or replace the file with `content`, creating parent directories."""
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    data = content.encode("utf-8")
    with open(path, "wb") as f:
        f.write(data)
    return f"wrote {len(data)} bytes to {path}"


def edit_file(path, old, new, replace_all=False):
    """Replace `old` with `new`; `old` must occur exactly once unless `replace_all`."""
    if not old:
        raise OpError("old must not be empty")
    with open(path, encoding="utf-8", newline="") as f:
        text = f.read()
    count = text.count(old)
    if count == 0:
        raise OpError(f"old text not found in {path}")
    if count > 1 and not replace_all:
        raise OpError(f"old text appears {count} times in {path}; add context or set replace_all")
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text.replace(old, new) if replace_all else text.replace(old, new, 1))
    n = count if replace_all else 1
    return f"replaced {n} occurrence{'s' if n > 1 else ''} in {path}"


def list_dir(path="."):
    """Return the directory's entries, sorted, with a `/` after each subdirectory."""
    with os.scandir(path) as entries:
        names = sorted(e.name + ("/" if e.is_dir(follow_symlinks=False) else "") for e in entries)
    return "\n".join(names) or "(empty)"


def search(pattern, path=".", glob=None):
    """Return `file:line:text` for each line matching the regex `pattern`.

    Skips `.git`, binary files, and files over 2 MB; `glob` filters on the file name
    or its path.
    """
    try:
        rx = re.compile(pattern)
    except re.error as exc:
        raise OpError(f"bad pattern: {exc}") from exc
    matches = []
    for file in _walk(path):
        if glob and not (fnmatch.fnmatch(os.path.basename(file), glob) or fnmatch.fnmatch(file, glob)):
            continue
        try:
            if os.path.getsize(file) > MAX_SEARCH_FILE_BYTES:
                continue
            with open(file, "rb") as f:
                data = f.read()
        except OSError:
            continue
        if b"\0" in data[:8192]:
            continue
        for number, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
            if rx.search(line):
                matches.append(f"{file}:{number}:{line[:MAX_LINE_CHARS]}")
                if len(matches) >= MAX_MATCHES:
                    return "\n".join(matches) + f"\n[stopped at {MAX_MATCHES} matches]"
    return "\n".join(matches) or "(no matches)"


def _walk(path):
    if os.path.isfile(path):
        yield path
        return
    for root, dirs, files in os.walk(path):
        dirs[:] = sorted(d for d in dirs if d != ".git")
        for name in sorted(files):
            yield os.path.normpath(os.path.join(root, name))


OPS = {"read_file": read_file, "write_file": write_file, "edit_file": edit_file, "list": list_dir, "search": search}


def main():
    """Serve one request from stdin; exit 0 on success, 1 on a reported error."""
    try:
        request = json.load(sys.stdin)
        op = OPS.get(request.pop("op", None))
        if op is None:
            raise OpError("unknown op")
        reply = {"ok": True, "output": op(**request)}
    except OSError as exc:
        reply = {"ok": False, "error": f"{exc.strerror}: {exc.filename}" if exc.filename else str(exc)}
    except (OpError, UnicodeError, TypeError, ValueError) as exc:
        reply = {"ok": False, "error": str(exc)}
    json.dump(reply, sys.stdout)
    sys.exit(0 if reply["ok"] else 1)


if __name__ == "__main__":
    main()

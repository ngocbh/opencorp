"""Writing service files: atomically, so a crash never leaves launchd or systemd half a file."""

import os
from pathlib import Path


def write_if_changed(path: Path, data: bytes) -> bool:
    """Write ``data`` to ``path`` unless it already holds exactly that; return whether it changed."""
    try:
        if path.read_bytes() == data:
            return False
    except FileNotFoundError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return True

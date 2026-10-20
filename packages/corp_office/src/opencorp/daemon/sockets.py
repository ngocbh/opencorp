"""The sockets the office listens on: 0600 unix sockets in the office dir, and HQ's TCP socket on 127.0.0.1."""

import os
import socket
import stat
import sys
from pathlib import Path

# sockaddr_un.sun_path, including the terminating NUL.
SUN_PATH_MAX = 104 if sys.platform == "darwin" else 108


class OfficeStartError(Exception):
    """The daemon can't start; the message says why."""


def check_socket_path(path: Path) -> None:
    """Raise ``OfficeStartError`` if ``path`` is too long for a unix socket."""
    size = len(os.fsencode(path))
    if size >= SUN_PATH_MAX:
        raise OfficeStartError(f"socket path too long ({size} bytes, limit {SUN_PATH_MAX - 1}): {path}")


def remove_stale_socket(path: Path) -> None:
    """Unlink the socket a crashed daemon left at ``path``; ``OfficeStartError`` if something else is there."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(st.st_mode):
        raise OfficeStartError(f"{path} exists and is not a socket")
    path.unlink(missing_ok=True)


def bind_socket(path: Path) -> socket.socket:
    """A listening unix socket at ``path`` with mode 0600."""
    check_socket_path(path)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    # uvicorn's --uds chmods the socket to 0666. Until listen() nobody can connect, so
    # chmod between bind and listen leaves no window, without a process-wide umask change.
    try:
        sock.bind(str(path))
        os.chmod(path, 0o600)
        sock.listen(128)
    except OSError as exc:
        sock.close()
        raise OfficeStartError(f"can't listen on {path}: {exc}") from exc
    return sock


def bind_tcp(port: int) -> socket.socket:
    """A listening TCP socket on 127.0.0.1:``port`` (0: any free port).

    ``SO_REUSEADDR`` lets a restart bind past TIME_WAIT, as uvicorn's own ``bind_socket`` and asyncio's
    ``create_server`` do; ``SO_REUSEPORT`` is never set, since it would let another socket share the port.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", port))
        sock.listen(128)
    except OSError:
        sock.close()
        raise
    sock.setblocking(False)
    return sock

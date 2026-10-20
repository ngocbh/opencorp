"""Network helpers for HQ's tests."""

import socket


def free_port() -> int:
    """A TCP port on 127.0.0.1 that nothing listens on right now."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]

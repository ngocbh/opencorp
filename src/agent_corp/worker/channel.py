"""Length-prefixed JSON frames over a socket, for traffic between the office and a worker."""

import dataclasses
import enum
import json
import socket
import struct
import threading
from collections.abc import Mapping
from pathlib import PurePath
from typing import Any

from pydantic import BaseModel

MAX_FRAME = 64 << 20
_HEADER = struct.Struct(">I")


class ChannelClosed(Exception):
    """The other end closed the channel, or the socket broke."""


class FrameTooLarge(ValueError):
    """A frame is bigger than ``MAX_FRAME`` bytes."""


class Channel:
    """JSON-object frames, each sent as a 4-byte big-endian length and UTF-8 JSON.

    ``send`` may be called from any thread; ``recv`` from one reader thread.
    """

    def __init__(self, sock: socket.socket) -> None:
        self.sock = sock
        self._reader = sock.makefile("rb")
        self._send_lock = threading.Lock()

    def send(self, frame: Mapping[str, Any]) -> None:
        """Send one frame; raise ``FrameTooLarge``, or ``ChannelClosed`` if the socket is gone."""
        data = json.dumps(frame, ensure_ascii=False, separators=(",", ":")).encode()
        if len(data) > MAX_FRAME:
            raise FrameTooLarge(f"a {len(data)}-byte frame is over the {MAX_FRAME}-byte limit")
        with self._send_lock:
            try:
                self.sock.sendall(_HEADER.pack(len(data)) + data)
            except OSError as exc:
                raise ChannelClosed(str(exc)) from exc

    def recv(self) -> dict[str, Any]:
        """Block for the next frame; raise ``ChannelClosed`` at end of stream."""
        (size,) = _HEADER.unpack(self._read(_HEADER.size))
        if size > MAX_FRAME:
            raise FrameTooLarge(f"a {size}-byte frame is over the {MAX_FRAME}-byte limit")
        frame = json.loads(self._read(size))
        if not isinstance(frame, dict):
            raise ValueError(f"a frame must be a JSON object, got {type(frame).__name__}")
        return frame

    def close(self) -> None:
        """Shut the socket down, which wakes a blocked ``recv`` on both ends."""
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()

    def _read(self, size: int) -> bytes:
        try:
            data = self._reader.read(size)
        except (OSError, ValueError):  # ValueError: the reader was closed by an earlier EOF
            data = b""
        if len(data) < size:
            # Closed from the reader thread, so no other thread holds the buffer's lock;
            # this also releases the socket's last file descriptor after close().
            self._reader.close()
            raise ChannelClosed("channel closed")
        return data


def jsonable(value: Any) -> Any:
    """``value`` as plain JSON data.

    Dataclasses, pydantic models, mappings, sequences, sets, enums, and paths are
    converted recursively; any other object becomes its ``repr``.
    """
    if isinstance(value, enum.Enum):
        return jsonable(value.value)
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {f.name: jsonable(getattr(value, f.name)) for f in dataclasses.fields(value)}
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, Mapping):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [jsonable(v) for v in value]
    if isinstance(value, PurePath):
        return str(value)
    return repr(value)

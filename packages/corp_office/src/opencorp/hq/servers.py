"""HQ's listeners: one uvicorn server each, on the office loop, so HQ's limits and failures never reach office.sock."""

from __future__ import annotations

import contextlib
from typing import Any

import h11
import uvicorn
from uvicorn.protocols.http.h11_impl import H11Protocol


class HqH11Protocol(H11Protocol):
    """uvicorn's h11 protocol with HQ's limits: at most ``MAX_OPEN`` open connections per listener, and
    ``HEAD_TIMEOUT_S`` seconds to send each complete request head (Go's ReadHeaderTimeout, nginx's
    client_header_timeout).

    uvicorn starts no timer when a connection opens, and stops its keep-alive timer at the first byte of the next
    request, so without the deadline a connection that never finishes its head stays open for good.
    """

    MAX_OPEN = 64
    HEAD_TIMEOUT_S = 10.0

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._head_timer: Any = None

    def connection_made(self, transport: Any) -> None:  # type: ignore[override]
        if len(self.connections) >= self.MAX_OPEN:
            self.transport = transport  # connection_lost reads it
            transport.abort()
            return
        super().connection_made(transport)
        self._arm_head()

    def data_received(self, data: bytes) -> None:
        super().data_received(data)
        if self.conn.their_state is not h11.IDLE:  # a whole request head arrived
            self._disarm_head()

    def on_response_complete(self) -> None:
        super().on_response_complete()
        if not self.transport.is_closing():
            self._arm_head()  # the next request's head gets its own deadline

    def connection_lost(self, exc: Exception | None) -> None:
        self._disarm_head()
        super().connection_lost(exc)

    def _arm_head(self) -> None:
        self._disarm_head()
        self._head_timer = self.loop.call_later(self.HEAD_TIMEOUT_S, self._head_expired)

    def _disarm_head(self) -> None:
        if self._head_timer is not None:
            self._head_timer.cancel()
            self._head_timer = None

    def _head_expired(self) -> None:
        self._head_timer = None
        if self.conn.their_state is h11.IDLE and not self.transport.is_closing():
            self.transport.close()


class HqServer(uvicorn.Server):
    """One HQ listener's server; the office's own server owns the signals."""

    @contextlib.contextmanager
    def capture_signals(self):
        yield


def hq_config(app: Any) -> uvicorn.Config:
    """An HQ listener's settings: no lifespan (the office's server starts the office), no WebSockets, no proxy
    headers, HQ's limits, and the logging the office already set up (``log_config=None``).

    No ``limit_concurrency``: ``HqH11Protocol`` already caps open connections, and uvicorn's check counts idle ones
    too, so 63 idle connections would get every request the owner makes a 503.
    """
    return uvicorn.Config(app, lifespan="off", ws="none", proxy_headers=False, http=HqH11Protocol,
                          timeout_keep_alive=5, timeout_graceful_shutdown=5, log_config=None)

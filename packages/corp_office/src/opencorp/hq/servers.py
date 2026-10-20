"""HQ's listeners: one uvicorn server each, on the office loop, so HQ's limits and failures never reach office.sock."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import socket
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

import h11
import uvicorn
from uvicorn.protocols.http.h11_impl import H11Protocol

from opencorp.daemon.sockets import OfficeStartError, bind_socket, bind_tcp, remove_stale_socket
from opencorp.hq.api import create_hq_app
from opencorp.protocol import stamp

if TYPE_CHECKING:
    from opencorp.hq.core import Hq

log = logging.getLogger(__name__)

RETRY_S = 5.0
"""How often a TCP port someone else holds is tried again."""


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


class Listeners:
    """HQ's servers for one office: on ``hq.sock`` always, and on TCP 127.0.0.1 when enabled, retried every
    ``RETRY_S`` seconds until the port is free. A taken port never stops the office."""

    def __init__(self, hq: Hq) -> None:
        self.hq = hq
        self._servers: list[tuple[HqServer, asyncio.Task[None], socket.socket]] = []
        self._tcp: asyncio.Task[None] | None = None

    async def start(self) -> None:
        """Listen on hq.sock, and start binding TCP in the background."""
        try:
            remove_stale_socket(self.hq.socket)  # the office holds its pidfile, so no live office owns it
            self._serve(bind_socket(self.hq.socket), port=None)
            self.hq.socket_error = None
        except OfficeStartError as exc:
            # Logged and kept for GET /hq and doctor: a path too long for sun_path mustn't fail silently.
            log.error("HQ can't listen on %s: %s", self.hq.socket, exc)
            self.hq.socket_error = str(exc)
        if self.hq.config.tcp:
            self._tcp = asyncio.create_task(self._bind_tcp())

    async def _bind_tcp(self) -> None:
        said = None
        while True:
            try:
                sock = bind_tcp(self.hq.config.port)
            except OSError as exc:
                why = exc.strerror or str(exc)
                self.hq.tcp_error = why
                self.hq.next_retry_at = stamp(datetime.now(UTC) + timedelta(seconds=RETRY_S))
                if why != said:
                    log.warning("HQ can't listen on 127.0.0.1:%d (%s); trying again every %g s",
                                self.hq.config.port, why, RETRY_S)
                    said = why
                await asyncio.sleep(RETRY_S)
                continue
            port = sock.getsockname()[1]
            self.hq.bound_port, self.hq.tcp_error, self.hq.next_retry_at = port, None, None
            log.info("HQ listening on http://127.0.0.1:%d/", port)
            self._serve(sock, port=port)
            return

    def _serve(self, sock: socket.socket, *, port: int | None) -> None:
        server = HqServer(hq_config(create_hq_app(self.hq.office, self.hq, port=port)))
        self._servers.append((server, asyncio.create_task(server.serve(sockets=[sock])), sock))

    async def stop(self) -> None:
        """Stop binding, stop every server (their streams already ended with the office's bus), remove hq.sock."""
        if self._tcp is not None:
            self._tcp.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._tcp
            self._tcp = None
        for server, _, _ in self._servers:
            server.should_exit = True
        await asyncio.gather(*(task for _, task, _ in self._servers), return_exceptions=True)
        for _, _, sock in self._servers:
            sock.close()
        self._servers.clear()
        self.hq.bound_port = self.hq.tcp_error = self.hq.next_retry_at = None
        self.hq.socket.unlink(missing_ok=True)

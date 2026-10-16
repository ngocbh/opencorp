"""A JSON-RPC client over a child's stdin and stdout, one JSON object per line: Codex app-server's stdio transport.

Codex's messages carry no ``"jsonrpc"`` key; requests are ``{"id", "method", "params"}``.
"""

import itertools
import json
import logging
import threading
from collections.abc import Callable
from typing import IO, Any

log = logging.getLogger(__name__)


class RpcError(Exception):
    """The server answered a request with a JSON-RPC error."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(f"{message} ({code})")
        self.code, self.message, self.data = code, message, data


class RpcClosed(Exception):
    """The connection closed before an answer came, or before a write."""


class JsonRpc:
    """Requests with answers, notifications, and the server's own requests and notifications.

    ``on_notification(method, params)`` and ``on_request(request_id, method, params)`` run on the reader thread, in
    arrival order, and must hand work off rather than block it: a human-paced approval would stall every event. A
    handler that raises is logged and the reading goes on; a request whose handler raised is answered with a
    JSON-RPC internal error (-32603). Lines that aren't JSON objects are logged and skipped. ``on_closed()`` runs
    once, when stdout ends. Writes are serialized, so any thread may call ``request``, ``notify``,
    ``reply`` and ``reply_error``.
    """

    def __init__(self, stdin: IO[bytes], stdout: IO[bytes], *, on_notification: Callable[[str, dict], None],
                 on_request: Callable[[Any, str, dict], None], on_closed: Callable[[], None]) -> None:
        self._in, self._out = stdin, stdout
        self._on_notification, self._on_request, self._on_closed = on_notification, on_request, on_closed
        self._ids = itertools.count(1)
        self._write = threading.Lock()
        self._lock = threading.Lock()
        self._waiting: dict[int, tuple[threading.Event, list[dict[str, Any]]]] = {}
        self._closed = False
        self._reader = threading.Thread(target=self._read, name="codex-rpc", daemon=True)

    def start(self) -> None:
        self._reader.start()

    def request(self, method: str, params: dict[str, Any] | None = None, *, timeout: float = 60.0) -> Any:
        """Send a request and wait for its result; ``RpcError`` for an error answer, ``RpcClosed`` if the server goes."""
        request_id = next(self._ids)
        done, box = threading.Event(), []
        with self._lock:
            if self._closed:
                raise RpcClosed(f"the app-server closed before answering {method}")
            self._waiting[request_id] = (done, box)
        try:
            self._send({"id": request_id, "method": method, "params": params or {}})
            if not done.wait(timeout):
                raise TimeoutError(f"{method} got no answer in {timeout:.0f}s")
        finally:
            with self._lock:
                self._waiting.pop(request_id, None)
        if not box:
            raise RpcClosed(f"the app-server closed before answering {method}")
        if "error" in box[0]:
            e = box[0]["error"] or {}
            raise RpcError(e.get("code", 0), e.get("message", ""), e.get("data"))
        return box[0].get("result")

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        self._send({"method": method, **({"params": params} if params is not None else {})})

    def reply(self, request_id: Any, result: dict[str, Any]) -> None:
        self._send({"id": request_id, "result": result})

    def reply_error(self, request_id: Any, code: int, message: str) -> None:
        self._send({"id": request_id, "error": {"code": code, "message": message}})

    def _send(self, msg: dict[str, Any]) -> None:
        line = (json.dumps(msg) + "\n").encode()
        with self._write:
            try:
                self._in.write(line)
                self._in.flush()
            except (BrokenPipeError, ValueError, OSError) as exc:
                raise RpcClosed(str(exc)) from exc

    def _handle_request(self, request_id: Any, method: str, params: dict) -> None:
        try:
            self._on_request(request_id, method, params)
        except Exception:
            log.exception("codex: the %s handler failed", method)
            try:  # Codex would wait for this answer forever
                self.reply_error(request_id, -32603, f"the office couldn't handle {method}")
            except RpcClosed:
                pass

    def _read(self) -> None:
        try:
            for raw in self._out:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    msg = None
                if not isinstance(msg, dict):
                    log.warning("codex: a line that isn't a JSON object: %r", raw[:200])
                    continue
                if "method" in msg and "id" in msg:
                    self._handle_request(msg["id"], msg["method"], msg.get("params") or {})
                elif "method" in msg:
                    try:
                        self._on_notification(msg["method"], msg.get("params") or {})
                    except Exception:
                        log.exception("codex: the %s handler failed", msg["method"])
                else:
                    with self._lock:
                        waiter = self._waiting.get(msg.get("id"))
                    if waiter is not None:
                        waiter[1].append(msg)
                        waiter[0].set()
        finally:
            with self._lock:
                self._closed = True
                waiting = list(self._waiting.values())
            for done, _ in waiting:
                done.set()
            self._on_closed()

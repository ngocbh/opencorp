"""The guard on every HQ request, before routing: Host, Fetch Metadata, Origin and body checks, and the security
headers on every response."""

import asyncio
from collections.abc import Iterable

from starlette.responses import RedirectResponse, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from opencorp.daemon.http import error

CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; "
       "connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
"""The page's Content-Security-Policy: no inline script or style, nothing from another origin."""

HEADERS = [(b"content-security-policy", CSP.encode()), (b"x-frame-options", b"DENY"),
           (b"x-content-type-options", b"nosniff"), (b"referrer-policy", b"no-referrer"),
           (b"cross-origin-opener-policy", b"same-origin")]
"""The headers added to every HQ response."""

MAX_API_BODY = 16 * 1024
"""The largest /api request body; the only writes are pairing and logging out."""

BODY_TIMEOUT_S = 10.0
"""How long a whole /api body may take after its head: a client trickling a body would otherwise hold a connection
for good."""

_READS = frozenset({"GET", "HEAD"})
_LOOPBACK = "127.0.0.1"


def is_api(path: str) -> bool:
    """Whether ``path`` is under /api."""
    return path == "/api" or path.startswith("/api/")


def header(scope: Scope, name: bytes) -> str | None:
    """The request's first ``name`` header (lowercase), or None."""
    return next((v.decode("latin-1") for k, v in scope["headers"] if k == name), None)


class HqGuard:
    """Pure ASGI middleware run on every HQ request, static paths and open endpoints included.

    ``port`` is the TCP listener's bound port, or None on ``hq.sock``, where the SSH forward picks the local port.
    ``dev_origins`` are extra origins /api accepts.
    """

    def __init__(self, app: ASGIApp, *, port: int | None, dev_origins: Iterable[str] = ()) -> None:
        self.app = app
        self.port = port
        self.dev_origins = frozenset(dev_origins)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            return await self.app(scope, receive, send)
        if scope["type"] != "http":
            # HQ servers run with WebSockets off; should one reach here anyway, it is refused, not routed.
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            return None

        async def secured(message: Message) -> None:
            if message["type"] == "http.response.start":
                message = {**message, "headers": [*message.get("headers", []), *HEADERS]}
            await send(message)

        refusal = self._refusal(scope)
        if refusal is not None:
            return await refusal(scope, receive, secured)
        if is_api(scope["path"]) and scope["method"] not in _READS:
            # Read the body here, so a chunked body over the cap, or one that stops arriving, is refused too.
            body = await _read_capped(receive, MAX_API_BODY, BODY_TIMEOUT_S)
            if body is None:  # the client went away; a partial body must never reach a route
                return None
            if isinstance(body, Response):
                return await body(scope, receive, secured)
            receive = _replay(body, receive)
        await self.app(scope, receive, secured)

    def _refusal(self, scope: Scope) -> Response | None:
        """The response that refuses the request, or None to let it through."""
        host = header(scope, b"host") or ""
        name, _, port = host.rpartition(":")
        api = is_api(scope["path"])
        port_ok = port.isascii() and port.isdecimal() and (self.port is None or int(port) == self.port)
        method = scope["method"]
        if name == "localhost" and port_ok and method in _READS and not api \
                and header(scope, b"sec-fetch-dest") in (None, "document"):
            # Cookies are per host name: send a localhost visit to the one name sessions live on.
            path = scope.get("raw_path") or scope["path"].encode()
            query = scope.get("query_string", b"")
            target = path.decode("latin-1") + (f"?{query.decode('latin-1')}" if query else "")
            return RedirectResponse(f"http://{_LOOPBACK}:{port}{target}", 307)
        if name != _LOOPBACK or not port_ok:  # a hostname is refused, which blocks DNS rebinding
            return error(403, "host_not_allowed", f"HQ answers only http://{_LOOPBACK}:<port>; open that address")
        if not api:
            return None
        if header(scope, b"sec-fetch-site") not in (None, "same-origin", "none"):
            # SameSite counts other local ports as the same site; Fetch Metadata tells them apart.
            return error(403, "cross_site", "HQ's API answers only its own pages")
        origin = header(scope, b"origin")
        allowed = origin in (f"http://{host}", *self.dev_origins)
        if (origin is not None and not allowed) or (origin is None and method not in _READS):
            return error(403, "origin_not_allowed", "HQ's API answers only its own pages")
        if method not in _READS:
            kind = (header(scope, b"content-type") or "").split(";")[0].strip().lower()
            if kind != "application/json":  # no CORS "simple" text/plain or form POST
                return error(415, "json_required", "HQ's API takes only JSON bodies")
            length = header(scope, b"content-length") or ""
            if length.isascii() and length.isdecimal() and int(length) > MAX_API_BODY:
                return _too_large()
        return None


def _too_large() -> Response:
    return error(413, "too_large", f"request body is over {MAX_API_BODY} bytes")


async def _read_capped(receive: Receive, cap: int, timeout: float) -> bytes | Response | None:
    """The whole request body; a 413 once it passes ``cap`` bytes, or a 408 if it takes longer than ``timeout``
    seconds in all; None if the client disconnects first."""
    body = bytearray()
    try:
        async with asyncio.timeout(timeout):
            while True:
                message = await receive()
                if message["type"] != "http.request":
                    return None
                body += message.get("body", b"")
                if len(body) > cap:
                    return _too_large()
                if not message.get("more_body", False):
                    return bytes(body)
    except TimeoutError:
        return error(408, "body_timeout", "the request body stopped arriving")


def _replay(body: bytes, receive: Receive) -> Receive:
    """A ``receive`` that gives ``body`` once, then waits on the real one (for the disconnect)."""
    sent = False

    async def replayed() -> Message:
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return await receive()

    return replayed

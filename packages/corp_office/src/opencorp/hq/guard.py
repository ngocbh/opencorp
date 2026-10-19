"""The guard on every HQ request, before routing: Host, Fetch Metadata and Origin checks, and the security headers
on every response."""

from collections.abc import Iterable
from typing import Any

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
        return None

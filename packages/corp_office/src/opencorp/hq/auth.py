"""The browser-session check on HQ's /api, after the guard: never the no-device fallback, never a Bearer token."""

from __future__ import annotations

from typing import TYPE_CHECKING

from starlette.types import ASGIApp, Receive, Scope, Send

from opencorp.daemon.http import error
from opencorp.hq.guard import header, is_api

if TYPE_CHECKING:
    from opencorp.hq.core import Hq

OPEN = frozenset({("GET", "/api/health"), ("HEAD", "/api/health"), ("POST", "/api/pair"), ("POST", "/api/login")})
"""The /api requests served without a session; every non-/api path (the app itself) is open too."""

SIGN_IN = ("Sign in with your handle and password, or run `opencorp pair` on the office machine and open the link it "
           "prints.")


def cookie_name(scope: Scope) -> str:
    """``opencorp_hq_<port>``, the port being the Host header's: cookies ignore ports, so the name tells HQs on one
    host apart."""
    return f"opencorp_hq_{(header(scope, b'host') or '').rpartition(':')[2]}"


def cookie_value(scope: Scope) -> str | None:
    """The request's HQ session cookie, or None."""
    name = cookie_name(scope)
    for part in (header(scope, b"cookie") or "").split(";"):
        key, _, value = part.strip().partition("=")
        if key == name and value:
            return value
    return None


class BrowserAuth:
    """Pure ASGI middleware: ties each /api request to a browser session, or answers 401."""

    def __init__(self, app: ASGIApp, hq: Hq) -> None:
        self.app = app
        self.hq = hq

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not is_api(scope["path"]) or (scope["method"], scope["path"]) in OPEN:
            return await self.app(scope, receive, send)
        who = await self.hq.sessions.check(cookie_value(scope))
        if who is None:
            return await error(401, "sign_in_required", SIGN_IN)(scope, receive, send)
        state = scope.setdefault("state", {})
        # The socket's read handlers run unchanged on these.
        state.update(person=who.person, device=who.name, hq_session=who.id, company=who.view)
        await self.app(scope, receive, send)

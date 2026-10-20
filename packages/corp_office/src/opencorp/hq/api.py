"""The HQ app each HQ listener serves: the /api allowlist and the built web app."""

from __future__ import annotations

from typing import TYPE_CHECKING

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route
from starlette.types import ASGIApp

from opencorp.daemon.http import EXCEPTION_HANDLERS, HTTPError, error, ok, parse
from opencorp.daemon.routes.costs import costs
from opencorp.daemon.routes.devices import whoami
from opencorp.daemon.routes.questions import list_questions
from opencorp.daemon.routes.sessions import list_sessions
from opencorp.daemon.routes.work_items import get_work_item
from opencorp.hq.auth import BrowserAuth, cookie_name, cookie_value
from opencorp.hq.guard import HqGuard
from opencorp.hq.static import serve_app
from opencorp.protocol.models import Ack, CompanyView, PairRequest

if TYPE_CHECKING:
    from opencorp.daemon.app import Office
    from opencorp.hq.core import Hq

ANY = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]

MAX_AGE = 30 * 24 * 3600
"""The cookie's lifetime in seconds: the session's."""


def get_hq(request: Request) -> Hq:
    """The Hq this app serves."""
    return request.app.state.hq


async def health(request: Request) -> JSONResponse:
    """The office's compatibility key and the built app's. Open without a session."""
    return ok(get_hq(request).health())


def _cookie(scope: dict, value: str, max_age: int = MAX_AGE) -> str:
    """The Set-Cookie header for HQ's session; ``Secure`` only on a real HTTPS connection."""
    secure = "; Secure" if scope.get("scheme") == "https" else ""
    return f"{cookie_name(scope)}={value}; HttpOnly; SameSite=Strict; Path=/; Max-Age={max_age}{secure}"


async def pair(request: Request) -> JSONResponse:
    """Spend a one-time code from a pairing link and sign this browser in. Open without a session.

    A local failure after the code is spent burns it; run `opencorp pair` again.
    """
    hq = get_hq(request)
    body = await parse(request, PairRequest)
    # Only a session the cookie really proves is replaced; a forged or stale cookie revokes nothing. Checked before
    # the code is spent, so a failing check doesn't burn it.
    old = await hq.sessions.check(cookie_value(request.scope))
    pending = hq.codes.redeem(body.code)
    if pending is None:
        raise HTTPError(400, "pair_code_invalid",
                        "This link has expired or was already used. Run `opencorp pair` again.")
    session, value = await hq.sessions.issue(pending.handle, issued_by=pending.issuer, label=body.label)
    if old is not None:
        await hq.sessions.revoke(old.id)  # pairing again replaces this browser's session
    response = ok(session)
    response.headers.append("set-cookie", _cookie(request.scope, value))
    return response


async def logout(request: Request) -> JSONResponse:
    """End this browser's session."""
    await get_hq(request).sessions.revoke(request.state.hq_session)
    response = ok(Ack(ok=True))
    response.headers.append("set-cookie", _cookie(request.scope, "", 0))
    return response


async def company(request: Request) -> JSONResponse:
    """The company at HEAD: the snapshot this request's session was checked against, so people, groups and the CEO
    come from one commit. People come without devices or password hashes."""
    view: CompanyView = request.state.company
    # The snapshot strips these already; stripped again here because this response goes to a browser.
    people = [p.model_copy(update={"devices": [], "password_hash": None}) for p in view.people]
    return ok(view.model_copy(update={"people": people}))


async def no_route(request: Request) -> JSONResponse:
    """Everything under /api that isn't on the allowlist."""
    return error(404, "no_route", f"no route {request.method} {request.url.path}")


def create_hq_app(office: Office, hq: Hq, *, port: int | None) -> ASGIApp:
    """The app one HQ listener serves: ``port`` is the TCP listener's bound port, None for ``hq.sock``.

    It never mounts the socket's routes, and the socket's app never mounts these, so routing fails closed. /api
    serves reads the Company page needs, pairing and logging out; writes (connections, devices, passwords, hire,
    prompts) stay socket-only.
    """
    api = [
        Route("/health", health, methods=["GET"]),
        Route("/whoami", whoami, methods=["GET"]),
        Route("/company", company, methods=["GET"]),
        Route("/sessions", list_sessions, methods=["GET"]),
        Route("/questions", list_questions, methods=["GET"]),
        Route("/work-items/{id}", get_work_item, methods=["GET"]),
        Route("/costs", costs, methods=["GET"]),
        Route("/pair", pair, methods=["POST"]),
        Route("/logout", logout, methods=["POST"]),
        Route("/{rest:path}", no_route, methods=ANY),
    ]
    app = Starlette(
        routes=[Route("/api", no_route, methods=ANY), Mount("/api", routes=api),
                Route("/{path:path}", serve_app, methods=["GET"])],
        exception_handlers=EXCEPTION_HANDLERS,
        # Inside Starlette's error handling, so a failing check is a 500 that still passes through the guard.
        middleware=[Middleware(BrowserAuth, hq=hq)],
    )
    app.state.office = office
    app.state.hq = hq
    # Outside Starlette, so its ServerErrorMiddleware's 500s pass through the guard and carry the headers too.
    return HqGuard(app, port=port, dev_origins=hq.config.dev_origins)

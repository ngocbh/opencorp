"""The HQ app each HQ listener serves: the /api allowlist and the built web app."""

from __future__ import annotations

import logging
import math
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Mount, Route
from starlette.types import ASGIApp

from opencorp.company.secret_keys import blank_secrets
from opencorp.company.source import SourceError
from opencorp.daemon.bus import PING
from opencorp.daemon.http import EXCEPTION_HANDLERS, HTTPError, error, ok, parse
from opencorp.daemon.routes.costs import costs
from opencorp.daemon.routes.devices import whoami
from opencorp.daemon.routes.events import PING_S, RESET, frame
from opencorp.daemon.routes.questions import list_questions
from opencorp.daemon.routes.runs import list_runs
from opencorp.daemon.routes.sessions import list_sessions
from opencorp.daemon.routes.work_items import get_work_item
from opencorp.hq.auth import BrowserAuth, cookie_name, cookie_value
from opencorp.hq.guard import HqGuard
from opencorp.hq.login import BadCredentials, Busy, Throttled
from opencorp.hq.static import serve_app
from opencorp.protocol.models import Ack, CompanyView, HqLoginRequest, PairRequest

if TYPE_CHECKING:
    from opencorp.daemon.app import Office
    from opencorp.hq.core import Hq

log = logging.getLogger(__name__)

ANY = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]

HQ_EVENT_TYPES = frozenset({"session.created", "session.updated", "question.created", "question.updated",
                            "work_item.created", "work_item.updated", "run.updated", "company.updated"})
"""What HQ's stream carries: sessions, questions, work items, runs and the company. No live transcript events,
profiles, feedback, debriefs, proposals or comments; run logs, which hold some of those, are read through /api/runs
(every signed-in human can read every one)."""

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


BAD_CREDENTIALS = "wrong handle or password"
"""The one answer to every failed sign-in, so nobody can tell which handles exist."""


async def login(request: Request) -> JSONResponse:
    """Sign this browser in with a human's handle and password. Open without a session.

    The session is the one pairing issues, with ``via`` "login"; the password is never logged.
    """
    hq = get_hq(request)
    body = await parse(request, HqLoginRequest)
    # HQ listens only on 127.0.0.1 and hq.sock, so the peer is in practice always 127.0.0.1 or "" (hq.sock): the
    # throttle keyed on it is per handle. Anyone who reaches HQ can lock a handle's password sign-in for a while,
    # which is why `opencorp pair` never goes through it and stays the way in.
    peer = request.client.host if request.client else ""
    who = f"@{body.handle} from {peer or 'hq.sock'}"
    try:
        checked = await hq.logins.check(peer, body.handle, body.password)
        # Only a session the cookie really proves is replaced; a forged or stale cookie revokes nothing.
        old = await hq.sessions.check(cookie_value(request.scope))
        try:
            session, value = await hq.sessions.issue(body.handle, issued_by=body.handle, label=body.label,
                                                     via="login", checked=checked)
        except HTTPError as exc:
            if exc.code not in ("not_a_human", "password_changed"):  # HEAD moved since the check
                raise
            raise BadCredentials from None
    except BadCredentials:
        log.info("sign-in for %s failed", who)
        return error(401, "bad_credentials", BAD_CREDENTIALS)
    except Throttled as exc:
        if exc.first:  # once per lock: a client retrying in a loop mustn't flood the log
            log.info("sign-in for %s throttled for %d s", who, exc.retry_after)
        minutes = math.ceil(exc.retry_after / 60)
        return error(429, "too_many_attempts",
                     f"too many tries; wait {minutes} minute{'s' * (minutes != 1)}, or run `opencorp pair` on the "
                     "office machine", {"retry-after": str(exc.retry_after)})
    except Busy:
        return error(503, "busy", "the office is busy; try again", {"retry-after": "1"})
    if old is not None:
        await hq.sessions.revoke(old.id)  # signing in again replaces this browser's session
    log.info("sign-in for %s ok", who)
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
    people = [blank_secrets(p) for p in view.people]
    return ok(view.model_copy(update={"people": people}))


async def company_tree(request: Request) -> JSONResponse:
    """The company repo's files at the commit this request's session was checked against, which becomes a commit
    files can be read at. Secret-revealing and non-UTF-8 paths are left out."""
    view: CompanyView = request.state.company
    return ok(await get_hq(request).source.tree(view.sha))


async def company_file(request: Request) -> JSONResponse:
    """One file at ``at``, one of the last commits the tree route served, with secrets hidden: 400 ``bad_path``,
    404 ``no_file`` or 409 ``stale_commit`` otherwise."""
    query = request.query_params
    try:
        found = await get_hq(request).source.file(query.get("at"), query.get("path"))
    except SourceError as exc:
        return error(exc.status, exc.code, exc.message)
    return ok(found)


async def events(request: Request) -> Response:
    """HQ's event stream: the /events contract (``: connected``, frames, ``reset``, pings) for HQ's event types.

    Every frame and ping checks the session's expiry and revocation, and each ``company.updated`` checks its person
    again at the new commit; a failing check ends the stream (the app then gets 401 and shows sign-in).
    """
    if request.method != "GET":  # a HEAD response to a stream that never ends would hold the connection
        return error(405, "method_not_allowed", f"{request.method} is not allowed on /api/events", {"allow": "GET"})
    hq = get_hq(request)
    sid = request.state.hq_session

    async def body() -> AsyncIterator[bytes]:
        # Subscribed here, not in the handler, so a response that never starts leaves no subscription behind.
        sub = hq.office.bus.subscribe(types=HQ_EVENT_TYPES)
        hq.sessions.register(sid, sub)
        try:
            yield b": connected\n\n"
            while hq.sessions.alive(sid):
                item = await sub.next(timeout=PING_S)
                if item is None:
                    if sub.dropped:
                        yield RESET
                    return
                if not hq.sessions.alive(sid):
                    return
                if item is PING:
                    yield b": ping\n\n"
                    continue
                kind, event = item
                if event.type == "company.updated":
                    try:
                        valid = await hq.sessions.still_valid(sid, event.subject_id)
                    except Exception:
                        # The app reconnects, and its next request checks the session at HEAD again.
                        log.exception("couldn't re-check HQ session %s at %s; ending its stream", sid,
                                      event.subject_id)
                        return
                    if not valid:
                        return
                yield frame(kind, event)
        finally:
            hq.sessions.unregister(sid, sub)
            sub.close()

    return StreamingResponse(body(), media_type="text/event-stream", headers={"cache-control": "no-cache"})


async def no_route(request: Request) -> JSONResponse:
    """Everything under /api that isn't on the allowlist."""
    return error(404, "no_route", f"no route {request.method} {request.url.path}")


def create_hq_app(office: Office, hq: Hq, *, port: int | None) -> ASGIApp:
    """The app one HQ listener serves: ``port`` is the TCP listener's bound port, None for ``hq.sock``.

    It never mounts the socket's routes, and the socket's app never mounts these, so routing fails closed. /api
    serves reads the Company page needs, pairing, signing in and logging out; writes (connections, devices,
    passwords, hire, prompts) stay socket-only.
    """
    api = [
        Route("/health", health, methods=["GET"]),
        Route("/whoami", whoami, methods=["GET"]),
        Route("/company", company, methods=["GET"]),
        Route("/company/tree", company_tree, methods=["GET"]),
        Route("/company/file", company_file, methods=["GET"]),
        Route("/sessions", list_sessions, methods=["GET"]),
        Route("/questions", list_questions, methods=["GET"]),
        Route("/runs", list_runs, methods=["GET"]),
        Route("/work-items/{id}", get_work_item, methods=["GET"]),
        Route("/costs", costs, methods=["GET"]),
        Route("/events", events, methods=["GET"]),
        Route("/pair", pair, methods=["POST"]),
        Route("/login", login, methods=["POST"]),
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

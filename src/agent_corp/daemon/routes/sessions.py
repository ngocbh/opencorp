"""Session routes: listing, reading, transcripts, and session actions."""

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from agent_corp.daemon.http import HTTPError, call, get_office, not_implemented, ok
from agent_corp.protocol.models import Session

DEFAULT_LIMIT = 50
MAX_LIMIT = 500


def _limit(raw: str | None) -> int:
    if raw is None:
        return DEFAULT_LIMIT
    try:
        limit = int(raw)
    except ValueError:
        limit = 0
    if not 1 <= limit <= MAX_LIMIT:
        raise HTTPError(422, "invalid_body", f"limit must be an integer from 1 to {MAX_LIMIT}")
    return limit


async def list_sessions(request: Request) -> JSONResponse:
    """Sessions, most recently updated first, optionally for one person."""
    q = request.query_params
    store = get_office(request).store
    return ok(await call(store.list_sessions, person=q.get("person"), limit=_limit(q.get("limit"))))


async def _session(request: Request) -> Session:
    session_id = request.path_params["id"]
    session = await call(get_office(request).store.get_session, session_id)
    if session is None:
        raise HTTPError(404, "not_found", f"no session {session_id}")
    return session


async def get_session(request: Request) -> JSONResponse:
    """One session."""
    return ok(await _session(request))


async def list_messages(request: Request) -> JSONResponse:
    """A session's transcript, oldest first."""
    session = await _session(request)
    return ok(await call(get_office(request).store.list_messages, session.id))


ROUTES = [
    Route("/sessions", list_sessions, methods=["GET"]),
    Route("/sessions", not_implemented, methods=["POST"]),
    Route("/sessions/{id}", get_session, methods=["GET"]),
    Route("/sessions/{id}/messages", list_messages, methods=["GET"]),
    Route("/sessions/{id}/prompt", not_implemented, methods=["POST"]),
    Route("/sessions/{id}/steer", not_implemented, methods=["POST"]),
    Route("/sessions/{id}/interrupt", not_implemented, methods=["POST"]),
    Route("/sessions/{id}/end", not_implemented, methods=["POST"]),
    Route("/sessions/{id}/cost-cap", not_implemented, methods=["POST"]),
]

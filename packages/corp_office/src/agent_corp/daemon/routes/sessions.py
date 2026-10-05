"""Session routes: listing, reading, transcripts, and session actions."""

from collections.abc import Callable
from typing import Any

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from agent_corp.chat.harness import Harness, HarnessError
from agent_corp.daemon.auth import acting_person
from agent_corp.daemon.http import HTTPError, call, get_office, ok, parse
from agent_corp.protocol.models import (Ack, CostCapRequest, CreateSessionRequest, PromptRequest, Session,
                                       SetModelRequest)

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


def harness(request: Request) -> Harness:
    """The office's chat harness; ``501`` if this office runs none."""
    found = get_office(request).extras.get("harness")
    if found is None:
        raise HTTPError(501, "not_implemented", f"{request.method} {request.url.path} is not implemented yet")
    return found


async def harness_call[T](fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """Run a blocking harness call in a thread; a ``HarnessError`` becomes its ``ApiError``."""
    try:
        return await call(fn, *args, **kwargs)
    except HarnessError as exc:
        raise HTTPError(exc.status, exc.code, exc.message) from exc


async def create_session(request: Request) -> JSONResponse:
    """Start a person's main chat in a folder, opened by the request's person, on the model the office chooses."""
    body = await parse(request, CreateSessionRequest)
    return ok(await harness_call(harness(request).start_session, body.person, body.cwd, body.harness,
                                 opened_by=acting_person(request), connection=body.connection, model=body.model))


async def prompt(request: Request) -> JSONResponse:
    """Send a message: the next turn, an answer to the model's question, a steer, or queued."""
    body = await parse(request, PromptRequest)
    await harness_call(harness(request).prompt, request.path_params["id"], body.text, by=acting_person(request))
    return ok(Ack(ok=True))


async def steer(request: Request) -> JSONResponse:
    """Steer the running reply (a prompt when none is running)."""
    body = await parse(request, PromptRequest)
    await harness_call(harness(request).steer, request.path_params["id"], body.text, by=acting_person(request))
    return ok(Ack(ok=True))


async def interrupt(request: Request) -> JSONResponse:
    """Esc: stop the running reply and its calls; the session stays open."""
    await harness_call(harness(request).interrupt, request.path_params["id"])
    return ok(Ack(ok=True))


async def end(request: Request) -> JSONResponse:
    """End the session (interrupting a busy reply first); a session already ending is left as it is."""
    await harness_call(harness(request).end, request.path_params["id"])
    return ok(Ack(ok=True))


async def cost_cap(request: Request) -> JSONResponse:
    """Set the session's cost cap; it must be above the cost so far. Held turns go on."""
    body = await parse(request, CostCapRequest)
    return ok(await harness_call(harness(request).set_cost_cap, request.path_params["id"], body.cost_cap_usd))


async def set_model(request: Request) -> JSONResponse:
    """Switch the session's connection and model; its next turn runs on them. Anyone who may chat may switch."""
    body = await parse(request, SetModelRequest)
    return ok(await harness_call(harness(request).set_model, request.path_params["id"], body.connection, body.model))


ROUTES = [
    Route("/sessions", list_sessions, methods=["GET"]),
    Route("/sessions", create_session, methods=["POST"]),
    Route("/sessions/{id}", get_session, methods=["GET"]),
    Route("/sessions/{id}/messages", list_messages, methods=["GET"]),
    Route("/sessions/{id}/prompt", prompt, methods=["POST"]),
    Route("/sessions/{id}/steer", steer, methods=["POST"]),
    Route("/sessions/{id}/interrupt", interrupt, methods=["POST"]),
    Route("/sessions/{id}/end", end, methods=["POST"]),
    Route("/sessions/{id}/cost-cap", cost_cap, methods=["POST"]),
    Route("/sessions/{id}/model", set_model, methods=["POST"]),
]

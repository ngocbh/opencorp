"""Learning routes: profile manager, profile proposals, feedback, and debriefs."""

from typing import Any

from agent_composer.memory.storage.markdown import MarkdownVersionMismatch
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from agent_corp.daemon.auth import acting_person
from agent_corp.daemon.http import HTTPError, get_office, ok, parse
from agent_corp.daemon.routes.sessions import harness_call
from agent_corp.protocol.models import (ConfirmFollowUpsRequest, FeedbackRequest, ProfileManagerRequest,
                                        VersionConflict)


def _learning(request: Request) -> Any:
    """The office's Learning; ``501`` if this office runs none."""
    found = get_office(request).extras.get("learning")
    if found is None:
        raise HTTPError(501, "not_implemented", f"{request.method} {request.url.path} is not implemented yet")
    return found


async def open_manager(request: Request) -> JSONResponse:
    """Open a profile-manager session over a person's profile, with the body's text as its first message."""
    learning = _learning(request)
    body = await parse(request, ProfileManagerRequest)
    return ok(await harness_call(learning.start_manager, request.path_params["handle"], body.text,
                                 by=acting_person(request)))


async def list_proposals(request: Request) -> JSONResponse:
    """A person's profile proposals, oldest first."""
    return ok(await harness_call(_learning(request).proposals, request.path_params["handle"]))


async def apply_proposal(request: Request) -> JSONResponse:
    """Apply an open proposal; ``409`` with both versions if the profile changed since it was made."""
    try:
        return ok(await harness_call(_learning(request).apply, request.path_params["id"], by=acting_person(request)))
    except MarkdownVersionMismatch as exc:
        conflict = VersionConflict(expected=exc.expected, current=exc.current)
        return JSONResponse(conflict.model_dump(mode="json"), status_code=409)


async def add_feedback(request: Request) -> JSONResponse:
    """Queue feedback on a finished run of a session."""
    learning = _learning(request)
    body = await parse(request, FeedbackRequest)
    return ok(await harness_call(learning.add_feedback, body, by=acting_person(request)))


async def get_debrief(request: Request) -> JSONResponse:
    """A session's debrief; a pending one is retried."""
    return ok(await harness_call(_learning(request).debrief, request.path_params["session"]))


async def confirm_follow_ups(request: Request) -> JSONResponse:
    """Confirm follow-ups of a ready debrief by index: one work item each."""
    learning = _learning(request)
    body = await parse(request, ConfirmFollowUpsRequest)
    return ok(await harness_call(learning.confirm, request.path_params["session"], body.indices,
                                 by=acting_person(request)))


ROUTES = [
    Route("/profiles/{handle}/manager", open_manager, methods=["POST"]),
    Route("/profiles/{handle}/proposals", list_proposals, methods=["GET"]),
    Route("/profile-proposals/{id}/apply", apply_proposal, methods=["POST"]),
    Route("/feedback", add_feedback, methods=["POST"]),
    Route("/debriefs/{session}", get_debrief, methods=["GET"]),
    Route("/debriefs/{session}/confirm", confirm_follow_ups, methods=["POST"]),
]

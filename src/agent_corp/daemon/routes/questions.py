"""Question routes: reading and answering questions, and question-card actions."""

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from agent_corp.daemon.http import HTTPError, call, get_office, not_implemented, ok, parse
from agent_corp.protocol.models import AnswerRequest
from agent_corp.store import InvalidTransition


async def get_question(request: Request) -> JSONResponse:
    """One question."""
    question_id = request.path_params["id"]
    question = await call(get_office(request).store.get_question, question_id)
    if question is None:
        raise HTTPError(404, "not_found", f"no question {question_id}")
    return ok(question)


async def answer_question(request: Request) -> JSONResponse:
    """Answer an open question; the first answer wins."""
    body = await parse(request, AnswerRequest)
    store = get_office(request).store
    try:
        question = await call(store.answer_question, request.path_params["id"], body.answer, body.answer_kind)
    except InvalidTransition as exc:
        raise HTTPError(409, "not_open", str(exc)) from exc
    return ok(question)


ROUTES = [
    Route("/questions/{id}", get_question, methods=["GET"]),
    Route("/questions/{id}/answer", answer_question, methods=["POST"]),
    Route("/questions/{id}/side", not_implemented, methods=["POST"]),
    Route("/questions/{id}/send-back", not_implemented, methods=["POST"]),
    Route("/questions/{id}/stop", not_implemented, methods=["POST"]),
]

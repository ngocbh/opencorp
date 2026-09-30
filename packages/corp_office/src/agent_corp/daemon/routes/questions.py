"""Question routes: listing, reading, and answering questions, and question-card actions."""

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from agent_corp.daemon.http import HTTPError, call, get_office, ok, parse
from agent_corp.daemon.routes.sessions import harness_call
from agent_corp.protocol.models import AnswerRequest, SendBackRequest, SideChatRequest
from agent_corp.questions.cards import Cards
from agent_corp.store import InvalidTransition


def cards(request: Request) -> Cards:
    """The office's question cards; ``501`` if this office runs no chat harness."""
    found = get_office(request).extras.get("cards")
    if found is None:
        raise HTTPError(501, "not_implemented", f"{request.method} {request.url.path} is not implemented yet")
    return found


async def list_questions(request: Request) -> JSONResponse:
    """Questions, oldest first, optionally for one session and in the given statuses.

    ``status`` may repeat or be comma-separated (``?status=open, answered``); an empty
    ``session`` counts as absent. SSE has no replay, so a client that (re)connects finds
    open questions here.
    """
    q = request.query_params
    statuses = [s.strip() for raw in q.getlist("status") for s in raw.split(",") if s.strip()]
    store = get_office(request).store
    return ok(await call(store.list_questions, session_id=q.get("session") or None, status=statuses or None))


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
    office = get_office(request)
    if "cards" in office.extras:  # checks the answer against its card and keeps the side chat's discussion
        return ok(await harness_call(office.extras["cards"].answer, request.path_params["id"], body.answer,
                                     body.answer_kind))
    if "harness" in office.extras:  # a chat turn, answer checks, and who answered
        return ok(await harness_call(office.extras["harness"].answer, request.path_params["id"], body.answer,
                                     body.answer_kind))
    try:
        question = await call(office.store.answer_question, request.path_params["id"], body.answer, body.answer_kind)
    except InvalidTransition as exc:
        raise HTTPError(409, "not_open", str(exc)) from exc
    return ok(question)


async def side_chat(request: Request) -> JSONResponse:
    """"Chat about this": send the first (or next) message to the question's side session; return the session."""
    body = await parse(request, SideChatRequest)
    return ok(await harness_call(cards(request).open_side, request.path_params["id"], body.text))


async def send_back(request: Request) -> JSONResponse:
    """Answer the question with its discussion and no decision; ``note`` is the human's last word in it."""
    body = await parse(request, SendBackRequest)
    return ok(await harness_call(cards(request).send_back, request.path_params["id"], body.note))


async def stop(request: Request) -> JSONResponse:
    """Stop the asker from its card: it gets ``[interrupted by the user]`` with the discussion."""
    return ok(await harness_call(cards(request).stop, request.path_params["id"]))


async def dismiss_carried(request: Request) -> JSONResponse:
    """Stop carrying an expired question's discussion into this one."""
    return ok(await harness_call(cards(request).dismiss_carried, request.path_params["id"]))


ROUTES = [
    Route("/questions", list_questions, methods=["GET"]),
    Route("/questions/{id}", get_question, methods=["GET"]),
    Route("/questions/{id}/answer", answer_question, methods=["POST"]),
    Route("/questions/{id}/side", side_chat, methods=["POST"]),
    Route("/questions/{id}/send-back", send_back, methods=["POST"]),
    Route("/questions/{id}/stop", stop, methods=["POST"]),
    Route("/questions/{id}/carried/dismiss", dismiss_carried, methods=["POST"]),
]

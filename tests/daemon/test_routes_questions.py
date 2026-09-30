"""Question routes."""

import pytest

from tests.daemon.test_app import ULID
from tests.store.conftest import question, session


@pytest.mark.parametrize(("path", "body"), [
    (f"/questions/{ULID}/side", {"text": "why?"}),
    (f"/questions/{ULID}/send-back", {"note": "more"}),
    (f"/questions/{ULID}/stop", None),
])
async def test_card_actions_are_not_implemented_yet(client, path, body):
    r = await client.post(path, json=body)
    assert r.status_code == 501 and r.json()["error"] == "not_implemented"


async def _open_question(office):
    s = office.store.create_session(session())
    return office.store.add_question(question(s.id))


def _ids(r):
    assert r.status_code == 200, r.json()
    return [q["id"] for q in r.json()]


async def test_list_questions_by_session_and_status(client, office):
    s1 = office.store.create_session(session())
    s2 = office.store.create_session(session())
    a = office.store.add_question(question(s1.id))
    b = office.store.add_question(question(s1.id))
    c = office.store.add_question(question(s2.id))
    office.store.answer_question(b.id, "yes", "text")
    assert _ids(await client.get("/questions")) == [a.id, b.id, c.id]
    assert _ids(await client.get("/questions", params={"session": s1.id})) == [a.id, b.id]
    assert _ids(await client.get("/questions", params={"session": s1.id, "status": "open"})) == [a.id]
    assert _ids(await client.get("/questions", params={"status": "open"})) == [a.id, c.id]
    both = [a.id, b.id, c.id]
    assert _ids(await client.get("/questions", params={"status": "open,answered"})) == both
    assert _ids(await client.get("/questions", params=[("status", "open"), ("status", "answered")])) == both


async def test_list_questions_with_an_unknown_status_or_session_is_empty(client, office):
    await _open_question(office)
    assert _ids(await client.get("/questions", params={"status": "pondering"})) == []
    assert _ids(await client.get("/questions", params={"session": ULID})) == []


async def test_get_question(client, office):
    q = await _open_question(office)
    r = await client.get(f"/questions/{q.id}")
    assert r.status_code == 200 and r.json()["status"] == "open"


async def test_missing_question_is_404(client):
    assert (await client.get(f"/questions/{ULID}")).status_code == 404
    r = await client.post(f"/questions/{ULID}/answer", json={"answer": 1, "answer_kind": "text"})
    assert r.status_code == 404 and r.json()["error"] == "not_found"


async def test_answer_then_second_answer_is_409(client, office):
    q = await _open_question(office)
    r = await client.post(f"/questions/{q.id}/answer", json={"answer": None, "answer_kind": "text"})
    assert r.status_code == 200
    assert r.json()["status"] == "answered" and r.json()["answer"] is None
    assert office.store.events_after()[-1].type == "question.updated"
    again = await client.post(f"/questions/{q.id}/answer", json={"answer": "b", "answer_kind": "option"})
    assert again.status_code == 409 and again.json()["error"] == "not_open"


@pytest.mark.parametrize("body", [{"answer": 1, "answer_kind": "sent_back"}, {"answer_kind": "text"}, "not json"])
async def test_bad_answer_body_is_422(client, office, body):
    q = await _open_question(office)
    kw = {"content": body} if isinstance(body, str) else {"json": body}
    r = await client.post(f"/questions/{q.id}/answer", **kw)
    assert r.status_code == 422 and r.json()["error"] == "invalid_body"

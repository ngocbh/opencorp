"""Question routes."""

from importlib.resources import files

import pytest

from opencorp.auth.tokens import new_token
from opencorp.extensions.questions import register
from opencorp.questions.side import SIDE_CHAT_FLOW
from tests.chat.conftest import CHAT_FLOW
from tests.company.conftest import base_files, write_repo
from tests.daemon.test_app import ULID
from tests.daemon.test_auth import add_human, bearer, give_device
from tests.daemon.test_routes_sessions import chat, fake_llm, until  # noqa: F401
from tests.store.conftest import question, session

SIDE_FLOW = (files("opencorp.company_template") / "shared" / "flows" / "side_chat.yaml").read_text()
ASK = {"tool_calls": [{"name": "ask_user", "arguments": {"question": "Retry or back off?",
                                                         "options": ["Retry", "Back off"]}}]}
CARD_ACTIONS = [
    (f"/questions/{ULID}/side", {"text": "why?"}),
    (f"/questions/{ULID}/send-back", {"note": "more"}),
    (f"/questions/{ULID}/stop", None),
    (f"/questions/{ULID}/carried/dismiss", None),
]


@pytest.fixture
def company(tmp_path):
    return write_repo(tmp_path / "company", base_files() | {"shared/flows/chat.yaml": CHAT_FLOW,
                                                            SIDE_CHAT_FLOW: SIDE_FLOW})


@pytest.fixture
def cards(chat):  # noqa: F811
    """The chat office with the question-cards extension loaded."""
    register(chat)
    return chat


async def asked(office, client, tmp_path):
    """Start minh's chat and have it ask the scripted question; return (session id, question id)."""
    (tmp_path / "ws").mkdir()
    sid = (await client.post("/sessions", json={"person": "minh", "cwd": str(tmp_path / "ws")})).json()["id"]
    await until(lambda: office.store.get_session(sid).status == "idle")
    assert (await client.post(f"/sessions/{sid}/prompt", json={"text": "fix the build"})).status_code == 200
    q = await until(lambda: office.store.list_questions(session_id=sid, status="open", source="ask_user"))
    return sid, q[0].id


def replies(store, sid):
    return [p.text for m in store.list_messages(sid) if m.role == "assistant" for p in m.parts if p.type == "text"]


@pytest.mark.parametrize(("path", "body"), CARD_ACTIONS)
async def test_card_actions_need_the_cards_extension(client, path, body):
    r = await client.post(path, json=body)
    assert r.status_code == 501 and r.json()["error"] == "not_implemented"


@pytest.mark.parametrize(("path", "body"), CARD_ACTIONS)
async def test_card_actions_on_a_missing_question_are_404(cards, client, path, body):
    r = await client.post(path, json=body)
    assert (r.status_code, r.json()["error"]) == (404, "not_found")


@pytest.mark.parametrize(("path", "body"), [
    (f"/questions/{ULID}/side", {"text": ""}),
    (f"/questions/{ULID}/side", {}),
    (f"/questions/{ULID}/send-back", {}),
    (f"/questions/{ULID}/send-back", {"note": "x", "extra": 1}),
])
async def test_bad_card_action_bodies_are_422(cards, client, path, body):
    r = await client.post(path, json=body)
    assert (r.status_code, r.json()["error"]) == (422, "invalid_body")


async def test_chat_about_a_question_then_answer_it(cards, client, fake_llm, tmp_path):
    fake_llm.script(ASK, {"content": "Retries hide flakes."}, {"content": "And cost calls."}, {"content": "OK."})
    store = cards.store
    sid, qid = await asked(cards, client, tmp_path)

    r = await client.post(f"/questions/{qid}/side", json={"text": "why ask?"})
    assert r.status_code == 200, r.json()
    side = r.json()
    assert (side["kind"], side["question_id"], side["person"]) == ("side", qid, "minh")
    assert store.get_question(qid).side_session_id == side["id"]
    await until(lambda: replies(store, side["id"]) == ["Retries hide flakes."]
                and store.get_session(side["id"]).status == "idle")
    main_system, side_system = (r["messages"][0]["content"] for r in fake_llm.requests()[:2])
    assert main_system.startswith("You are Minh (@minh), Engineer at test-corp.")
    assert side_system.startswith("You are Minh (@minh), Engineer at test-corp.") and "side conversation" in side_system
    # Later messages go to the side session itself; a second /side goes to the same session.
    assert (await client.post(f"/sessions/{side['id']}/prompt", json={"text": "and?"})).status_code == 200
    await until(lambda: len(store.get_question(qid).discussion) == 4)
    r = await client.post(f"/sessions/{side['id']}/prompt", json={"text": "/exit"})
    assert (r.status_code, r.json()["error"]) == (422, "refused")
    r = await client.post(f"/questions/{qid}/side", json={"text": "/exit"})
    assert (r.status_code, r.json()["error"]) == (422, "refused")

    r = await client.post(f"/questions/{qid}/answer", json={"answer": "Maybe", "answer_kind": "option"})
    assert (r.status_code, r.json()["error"]) == (422, "invalid_answer")
    r = await client.post(f"/questions/{qid}/answer", json={"answer": "Back off", "answer_kind": "option"})
    assert r.status_code == 200 and [e["text"] for e in r.json()["discussion"]] == [
        "why ask?", "Retries hide flakes.", "and?", "And cost calls."]
    await until(lambda: store.get_session(side["id"]).status == "ended")
    await until(lambda: replies(store, sid)[-1:] == ["OK."])
    r = await client.post(f"/questions/{qid}/side", json={"text": "late"})
    assert (r.status_code, r.json()["error"]) == (409, "not_open")
    turn = await until(lambda: store.list_questions(session_id=sid, status="open", source="human_input"))
    r = await client.post(f"/questions/{turn[0].id}/side", json={"text": "why?"})  # a chat turn is no card
    assert (r.status_code, r.json()["error"]) == (422, "not_a_card")


async def test_send_back_and_stop(cards, client, fake_llm, tmp_path):
    fake_llm.script(ASK, {"content": "Retries hide flakes."}, ASK)  # the sent-back reply asks again
    store = cards.store
    sid, qid = await asked(cards, client, tmp_path)
    r = await client.post(f"/questions/{qid}/send-back", json={"note": ""})
    assert (r.status_code, r.json()["error"]) == (422, "no_discussion")
    side = (await client.post(f"/questions/{qid}/side", json={"text": "why ask?"})).json()
    await until(lambda: store.get_session(side["id"]).status == "idle" and replies(store, side["id"]))
    r = await client.post(f"/questions/{qid}/send-back", json={"note": "give me numbers"})
    assert r.status_code == 200 and (r.json()["answer_kind"], r.json()["discussion"][-1]["text"]) == (
        "sent_back", "give me numbers")

    again = await until(lambda: [q for q in store.list_questions(session_id=sid, status="open", source="ask_user")])
    r = await client.post(f"/questions/{again[0].id}/stop")
    assert r.status_code == 200 and r.json()["answer_kind"] == "interrupted"
    await until(lambda: store.get_session(sid).status == "idle")


@pytest.mark.parametrize(("action", "body"), [("answer", {"answer": "Back off", "answer_kind": "option"}),
                                              ("send-back", {"note": ""})])
async def test_a_side_chat_and_its_decision_are_credited_to_the_verified_person(cards, client, company, fake_llm,
                                                                                tmp_path, action, body):
    add_human(company, "ava")  # before the chat starts, so the asker's pinned commit knows her
    fake_llm.script(ASK, {"content": "Retries hide flakes."}, {"content": "OK."})
    store = cards.store
    _, qid = await asked(cards, client, tmp_path)
    ava = new_token()
    give_device(company, "ava", "pc", ava)
    r = await client.post(f"/questions/{qid}/side", json={"text": "why ask?"}, headers=bearer(ava))
    assert r.status_code == 200 and r.json()["opened_by"] == "ava"
    side = r.json()["id"]
    await until(lambda: replies(store, side) == ["Retries hide flakes."] and store.get_session(side).status == "idle")
    assert "You're talking with Ava (@ava), your peer." in fake_llm.requests()[1]["messages"][0]["content"]
    r = await client.post(f"/questions/{qid}/{action}", json=body, headers=bearer(ava))
    assert r.status_code == 200 and r.json()["answered_by"] == "ava"


async def test_stopping_a_manager_question_is_credited_to_the_verified_person(cards, client, company, fake_llm,
                                                                              tmp_path):
    fake_llm.script({"tool_calls": [{"name": "ask_manager", "arguments": {"question": "Budget?"}}]},
                    {"content": "Carrying on."})
    store = cards.store
    (tmp_path / "ws").mkdir()
    # Opened while no one has a device: the chat is the CEO's.
    sid = (await client.post("/sessions", json={"person": "minh", "cwd": str(tmp_path / "ws")})).json()["id"]
    await until(lambda: store.get_session(sid).status == "idle")
    assert (await client.post(f"/sessions/{sid}/prompt", json={"text": "plan it"})).status_code == 200
    q = (await until(lambda: store.list_questions(session_id=sid, status="open", source="ask_manager")))[0]
    add_human(company, "ava")
    ava = new_token()
    give_device(company, "ava", "pc", ava)
    r = await client.post(f"/questions/{q.id}/stop", headers=bearer(ava))
    assert r.status_code == 200 and r.json()["answered_by"] == "ava"
    await until(lambda: store.get_work_item(q.work_item_id).resolved_by == "ava")


async def test_dismiss_a_carried_discussion(cards, client):
    s = cards.store.create_session(session())
    old = cards.store.add_question(question(s.id))
    q = cards.store.add_question(question(s.id))
    cards.store.update_question(q.id, carried_from=old.id)
    r = await client.post(f"/questions/{q.id}/carried/dismiss")
    assert r.status_code == 200 and r.json()["carried_from"] is None


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


async def test_list_questions_strips_statuses_and_ignores_an_empty_session(client, office):
    a = await _open_question(office)
    b = await _open_question(office)
    office.store.answer_question(b.id, "yes", "text")
    assert _ids(await client.get("/questions", params={"status": " open , answered "})) == [a.id, b.id]
    assert _ids(await client.get("/questions", params={"session": "", "status": "open"})) == [a.id]


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


async def test_a_plain_answer_is_credited_to_the_verified_person(client, office, company):
    add_human(company, "ava")
    ava = new_token()
    give_device(company, "ava", "pc", ava)
    q = await _open_question(office)
    r = await client.post(f"/questions/{q.id}/answer", json={"answer": "a", "answer_kind": "text"}, headers=bearer(ava))
    assert r.status_code == 200 and r.json()["answered_by"] == "ava"


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

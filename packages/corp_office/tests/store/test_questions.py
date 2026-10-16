"""Questions: round-trips, the human_input key, status moves, first answer wins."""

import datetime
import threading

import pytest

from agent_corp.store import DuplicateKey, InvalidTransition, StoreError
from tests.store.conftest import question as make_question
from tests.store.conftest import session

PAGES = [
    {"question": "Which db?", "header": "DB", "options": [{"label": "sqlite", "description": "local"}, {"label": "pg"}]},
    {"question": "Which tests?", "header": "Tests", "options": [{"label": "unit"}, {"label": "e2e"}], "multi_select": True},
]
SCHEMA = [
    {"name": "db", "type": "str", "required": True, "enum": ["sqlite", "pg"]},
    {"name": "tests", "type": "list[str]", "required": True},
]


@pytest.fixture
def sid(store):
    return store.create_session(session()).id


def test_two_page_question_round_trips(store, sid):
    q = make_question(sid, title="Setup", questions=PAGES, answer_schema=SCHEMA, options=["a", "b"], gate=True,
                      discussion=[{"role": "user", "text": "why?"}])
    got = store.add_question(q)
    assert got == q == store.get_question(q.id)
    assert got.model_dump(mode="json") == q.model_dump(mode="json")
    assert len(got.questions) == 2 and got.questions[1].multi_select
    assert store.events_after()[-1].type == "question.created"


def test_human_input_key_is_unique(store, sid):
    store.add_question(make_question(sid, node_id="chat#0/ask", source="human_input"))
    with pytest.raises(DuplicateKey):
        store.add_question(make_question(sid, node_id="chat#0/ask", source="human_input"))
    store.add_question(make_question(sid, node_id="chat#0/ask", source="human_input", run_id="run-2"))
    found = store.get_question_by_node("run-1", "chat#0/ask")
    assert found.node_id == "chat#0/ask" and store.get_question_by_node("run-1", "other") is None


def test_many_null_node_questions(store, sid):
    for _ in range(3):
        store.add_question(make_question(sid))
    assert len(store.list_questions(run_id="run-1")) == 3


def test_answer_is_absent_until_answered(store, sid):
    q = store.add_question(make_question(sid))
    assert q.answer is None and "answer" not in q.model_dump(exclude_unset=True)
    answered = store.answer_question(q.id, None, "text", answered_by="ngocbh")
    assert answered.status == "answered" and "answer" in answered.model_dump(exclude_unset=True)
    assert answered.answer is None and store.get_question(q.id).model_fields_set >= {"answer"}
    other = store.answer_question(store.add_question(make_question(sid)).id, {"db": "pg"}, "option")
    assert other.answer == {"db": "pg"} and other.answer_kind == "option"
    assert store.events_after()[-1].type == "question.updated"


@pytest.mark.parametrize(
    ("path", "bad"),
    [
        ([], "consumed"),
        (["stale"], "consumed"),
        (["answer"], "stale"),
        (["answer", "consumed"], "stale"),
        (["answer", "consumed"], "consumed"),
        (["stale"], "stale"),
    ],
)
def test_status_moves_only_forward(store, sid, path, bad):
    q = store.add_question(make_question(sid))
    for step in path:
        if step == "answer":
            store.answer_question(q.id, "x", "text")
        else:
            store.set_question_status(q.id, step)
    with pytest.raises(InvalidTransition):
        store.set_question_status(q.id, bad)


def test_status_happy_paths(store, sid):
    a = store.add_question(make_question(sid))
    store.answer_question(a.id, "x", "text")
    assert store.set_question_status(a.id, "consumed").answer == "x"
    b = store.add_question(make_question(sid))
    assert store.set_question_status(b.id, "stale").status == "stale"
    with pytest.raises(InvalidTransition):
        store.answer_question(b.id, "late", "text")
    with pytest.raises(InvalidTransition):
        store.set_question_status(b.id, "answered")


def test_first_answer_wins(store, sid):
    q = store.add_question(make_question(sid))
    barrier = threading.Barrier(2)
    results = []

    def answer(text):
        barrier.wait()
        try:
            store.answer_question(q.id, text, "text")
            results.append(("ok", text))
        except InvalidTransition:
            results.append(("lost", text))

    threads = [threading.Thread(target=answer, args=(t,)) for t in ("first", "second")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    [(_, winner)] = [r for r in results if r[0] == "ok"]
    assert len(results) == 2 and store.get_question(q.id).answer == winner


def test_update_question_fields(store, sid):
    q = store.add_question(make_question(sid))
    side = session()
    store.create_session(side)
    got = store.update_question(q.id, side_session_id=side.id, discussion=[{"role": "assistant", "text": "hi"}])
    assert got.side_session_id == side.id and got.discussion[0].text == "hi"
    with pytest.raises(StoreError):
        store.update_question(q.id, status="answered")


def test_list_questions_filters(store, sid):
    a = store.add_question(make_question(sid))
    b = store.add_question(make_question(sid, source="human_input", node_id="n"))
    store.answer_question(b.id, "x", "text")
    assert [q.id for q in store.list_questions(session_id=sid, status="open", source="ask_user")] == [a.id]
    assert [q.id for q in store.list_questions(session_id=sid, status=("answered", "consumed"))] == [b.id]


def test_answer_is_stored_as_its_json_dump(store, sid):
    q = store.add_question(make_question(sid))
    got = store.answer_question(q.id, {"when": datetime.date(2026, 9, 30), "picks": ("a", "b")}, "text")
    assert got.answer == {"when": "2026-09-30", "picks": ["a", "b"]} == store.get_question(q.id).answer


@pytest.mark.parametrize("status", ["open", "stale"])
def test_unanswered_question_keeps_no_answer_fields(store, sid, status):
    q = make_question(sid, status=status, answer={"x": 1}, answer_kind="text", answered_by="minh")
    got = store.add_question(q)
    assert (got.answer, got.answer_kind, got.answered_by) == (None, None, None)
    assert got == store.get_question(q.id)


def test_answered_question_keeps_its_answer_fields(store, sid):
    q = make_question(sid, status="consumed", answer="x", answer_kind="text", answered_by="minh")
    got = store.add_question(q)
    assert (got.answer, got.answer_kind, got.answered_by) == ("x", "text", "minh")


def test_a_harness_question_keeps_its_secret_page(store):
    sid = store.create_session(session(harness="codex")).id
    page = {"question": "Paste the API key", "header": "Key", "options": [], "secret": True}
    q = store.add_question(make_question(sid, source="harness", run_id="turn-1", node_id="7", questions=[page]))
    store.add_question(make_question(sid))
    assert store.get_question(q.id) == q and q.questions[0].secret is True
    assert [x.id for x in store.list_questions(source="harness")] == [q.id]

"""The office side of a run's ask_user: the handler, and storing then waiting for answers."""

import threading

import pytest
from agent_composer.tools import ToolSet

from agent_corp.protocol.models import DiscussionEntry, Question
from agent_corp.questions import ask as ask_module
from agent_corp.questions.ask import Answers, AnswersClosed, QuestionExpired, make_ask_user
from agent_corp.store import NotFound, Store
from agent_corp.worker.rpc import ASK_KEYS, BaseHandlers, ask_user_stub
from tests.store.conftest import question as make_question
from tests.store.conftest import session, work_item
from tests.store.conftest import store  # noqa: F401
from tests.worker.conftest import office_end

PAGES = [{"question": "Which db?", "header": "DB", "options": [{"label": "sqlite", "description": "local"}],
          "multi_select": False}]
SCHEMA = [{"name": "DB", "type": "str", "required": True}]


def model_call(**over):
    return {"question": "Retry or back off?", "questions": None, "answer_schema": None, "title": None,
            "node_id": None, "options": ["Retry", "Back off", "Chat about this"]} | over


def human_input_call(**over):
    return {"question": "", "questions": PAGES, "answer_schema": SCHEMA, "title": "Setup",
            "node_id": "sop#0/ask", "options": None} | over


class Desk:
    """An on_question that records the question and answers it at once."""

    def __init__(self, answer, kind="option"):
        self.asked: list[Question] = []
        self.answer, self.kind = answer, kind

    def __call__(self, q: Question, *, work_item=None) -> Question:
        self.asked.append(q)
        return q.model_copy(update={"status": "answered", "answer": self.answer, "answer_kind": self.kind})


def test_the_handler_passes_composers_check_and_takes_its_calls():
    desk = Desk("B")
    tools = ToolSet({"ask_user": make_ask_user(session(), "run-1", desk)})
    assert tools.invoke("ask_user", {"question": "A or B?", "options": '["A","B"]'}) == (
        'The user chose "B" (option 2 of the 2 shown).')
    desk.answer = {"DB": "sqlite"}
    assert tools.invoke_trusted("ask_user", human_input_call()) == {"DB": "sqlite"}
    assert [q.source for q in desk.asked] == ["ask_user", "human_input"]
    assert set(ASK_KEYS) == set(model_call())


def test_the_handler_answers_through_the_workers_stub():
    desk = Desk("B")
    handler = make_ask_user(session(), "run-1", desk)

    class Handlers(BaseHandlers):
        def ask_user(self, worker, request):
            return handler(**request)

    with office_end(Handlers(), threaded=True) as rpc:
        tools = ToolSet({"ask_user": ask_user_stub(rpc)})
        got = tools.invoke("ask_user", {"question": "A or B?", "options": ["A", "B"]})
    assert got == 'The user chose "B" (option 2 of the 2 shown).' and desk.asked[0].options == ["A", "B"]


def test_a_model_call_stores_a_flat_question_and_returns_the_formatted_answer():
    s = session(work_item_id="01J9ZZZZZZZZZZZZZZZZZZZZZZ")
    desk = Desk("Back off")
    got = make_ask_user(s, "run-1", desk, names=("minh",))(**model_call())
    assert got == 'The user chose "Back off" (option 2 of the 2 shown).'
    [q] = desk.asked
    assert (q.source, q.node_id, q.asker, q.session_id, q.run_id, q.work_item_id) == (
        "ask_user", None, "minh", s.id, "run-1", s.work_item_id)
    assert q.options == ["Retry", "Back off"] and q.questions is None and q.answer_schema == []
    assert q.status == "open" and Question.model_validate(q.model_dump()) == q


def test_a_model_call_with_bad_options_still_asks():
    desk = Desk("fine", kind="text")
    assert make_ask_user(session(), "run-1", desk)(**model_call(options={"x": 1})) == "The user answered: fine"
    assert desk.asked[0].options == []


def test_a_human_input_call_keeps_its_node_pages_and_schema():
    desk = Desk({"DB": "sqlite"})
    got = make_ask_user(session(), "run-1", desk)(**human_input_call())
    assert got == {"DB": "sqlite"}
    [q] = desk.asked
    assert (q.source, q.node_id, q.title, q.question) == ("human_input", "sop#0/ask", "Setup", "")
    assert q.questions[0].options[0].description == "local" and q.answer_schema[0].name == "DB"
    assert q.options == []


def test_a_carried_discussion_reaches_the_answer():
    handler = make_ask_user(session(), "run-1", Desk("x", kind="text"),
                            carried=lambda q: [DiscussionEntry(role="user", text="before")])
    assert handler(**model_call()).endswith('[{"role":"note","text":"from an earlier, expired question"},'
                                            '{"role":"user","text":"before"}]')


@pytest.fixture
def sid(store):
    return store.create_session(session()).id


@pytest.fixture
def answers(store):
    a = Answers(store)
    yield a
    a.close()


def wait_open(store, sid, count=1):
    for _ in range(500):
        if len(found := store.list_questions(session_id=sid, status="open")) >= count:
            return found
        threading.Event().wait(0.01)
    raise AssertionError("the question was never stored")


def test_ask_stores_then_blocks_until_answered_and_marks_consumed(store, answers, sid):
    q = make_question(sid)
    out = {}
    t = threading.Thread(target=lambda: out.update(result=answers.ask(q)), daemon=True)
    t.start()
    [stored] = wait_open(store, sid)
    assert stored.id == q.id and t.is_alive()
    store.answer_question(q.id, "pg", "text", answered_by="ngocbh")
    t.join(5)
    assert out["result"].answer == "pg" and out["result"].status == "consumed"
    assert store.get_question(q.id).status == "consumed"


def test_a_question_that_goes_stale_raises(store, answers, sid):
    q = make_question(sid)
    out = {}

    def ask():
        try:
            answers.ask(q)
        except QuestionExpired as exc:
            out["error"] = exc

    t = threading.Thread(target=ask, daemon=True)
    t.start()
    wait_open(store, sid)
    store.set_question_status(q.id, "stale")
    t.join(5)
    assert isinstance(out["error"], QuestionExpired)


def test_a_re_asked_human_input_finds_its_stored_question(store, answers, sid):
    first = store.add_question(make_question(sid, source="human_input", node_id="sop#0/ask"))
    store.answer_question(first.id, "kept", "text")
    again = make_question(sid, source="human_input", node_id="sop#0/ask")
    got = answers.ask(again)
    assert got.id == first.id and got.answer == "kept"
    assert len(store.list_questions(session_id=sid)) == 1


def test_a_work_item_is_stored_with_its_question(store, answers, sid):
    item = work_item(kind="question")
    q = make_question(sid, work_item_id=item.id)
    t = threading.Thread(target=answers.ask, args=(q,), kwargs={"work_item": item}, daemon=True)
    t.start()
    [stored] = wait_open(store, sid)
    assert stored.work_item_id == item.id and store.get_work_item(item.id).status == "open"
    store.answer_question(q.id, "pg", "text")
    t.join(5)
    assert not t.is_alive()


def test_a_question_that_cannot_be_stored_leaves_no_work_item(store, answers):
    item = work_item(kind="question")
    with pytest.raises(NotFound):
        answers.ask(make_question("01J9ZZZZZZZZZZZZZZZZZZZZZZ", work_item_id=item.id), work_item=item)
    assert store.get_work_item(item.id) is None


def test_a_question_that_goes_stale_cancels_its_work_item(store, answers, sid):
    item = work_item(kind="question")
    q = make_question(sid, work_item_id=item.id)
    out = {}

    def ask():
        try:
            answers.ask(q, work_item=item)
        except QuestionExpired as exc:
            out["error"] = exc

    t = threading.Thread(target=ask, daemon=True)
    t.start()
    wait_open(store, sid)
    store.set_question_status(q.id, "stale")
    t.join(5)
    assert isinstance(out["error"], QuestionExpired)
    assert store.get_work_item(item.id).status == "cancelled"


def asking(answers, q):
    """Run ``answers.ask(q)`` on a thread; ``out`` gets its result or its error."""
    out = {}

    def ask():
        try:
            out["result"] = answers.ask(q)
        except Exception as exc:
            out["error"] = exc

    t = threading.Thread(target=ask, daemon=True)
    t.start()
    return t, out


def test_close_wakes_every_waiting_ask(store, answers, sid):
    waiting = [asking(answers, make_question(sid)) for _ in range(2)]
    wait_open(store, sid, count=2)
    answers.close()
    for t, out in waiting:
        t.join(5)
        assert isinstance(out.get("error"), AnswersClosed)


def test_ask_after_close_raises_and_stores_nothing(store, answers, sid):
    answers.close()
    with pytest.raises(AnswersClosed):
        answers.ask(make_question(sid))
    assert store.list_questions(session_id=sid) == []


def test_an_answer_that_lands_between_the_check_and_the_wait_still_wakes_ask(store, answers, sid, monkeypatch):
    monkeypatch.setattr(ask_module, "POLL_SECONDS", 60)
    q = make_question(sid)
    get_question = store.get_question

    def answered_right_after(qid):
        # ask sees the question open, then the answer lands before ask starts waiting.
        seen = get_question(qid)
        if seen.status == "open":
            monkeypatch.setattr(store, "get_question", get_question)
            store.answer_question(qid, "pg", "text")
        return seen

    monkeypatch.setattr(store, "get_question", answered_right_after)
    t, out = asking(answers, q)
    t.join(5)
    assert not t.is_alive() and out["result"].answer == "pg"


def test_an_answer_from_another_process_is_found_by_polling(store, answers, sid, monkeypatch, tmp_path):
    monkeypatch.setattr(ask_module, "POLL_SECONDS", 0.05)
    q = make_question(sid)
    t, out = asking(answers, q)
    wait_open(store, sid)
    with Store(tmp_path / "office" / "store.sqlite") as other:
        other.answer_question(q.id, "pg", "text")
    t.join(5)
    assert not t.is_alive() and out["result"].answer == "pg"

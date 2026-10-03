"""Company tools bound to the caller: ask_manager, create_work_item, comment."""

import pytest
from agent_composer.tools import ToolSet

from agent_corp.company.loader import load_repo
from agent_corp.questions.ask import Answers, QuestionExpired
from agent_corp.store import NotFound
from agent_corp.tools.company.work import company_tools
from agent_corp.worker.job import group_specs
from agent_corp.worker.rpc import model_from_schema
from tests.store.conftest import session, work_item


class Desk:
    """An on_question that stores through Answers; the manager answers each question as it is stored."""

    def __init__(self, store, answer, kind="option"):
        self.store, self.answer, self.kind = store, answer, kind
        self.asked = []
        self.answers = Answers(store)
        store.add_listener(self._answer)

    def __call__(self, q, *, work_item=None):
        self.asked.append(q)
        return self.answers.ask(q, work_item=work_item)

    def _answer(self, event):
        if event.type == "question.created" and self.answer is not ...:
            self.store.answer_question(event.subject_id, self.answer, self.kind, answered_by="ngocbh")


@pytest.fixture
def setup(store, company):
    item = store.create_work_item(work_item(requester="minh"))
    s = store.create_session(session(person="minh", work_item_id=item.id))
    desk = Desk(store, "Back off")
    tools = company_tools(store, load_repo(company), s, "run-1", desk)
    return store, s, item, desk, tools


def test_the_group_has_three_tools_and_no_ask_user(setup):
    *_, tools = setup
    assert set(tools) == {"ask_manager", "create_work_item", "comment"}
    [spec] = [s for s in group_specs({"company": tools})["company"] if s.name == "ask_manager"]
    assert spec.parameters["required"] == ["question"]
    assert ToolSet({"company": list(tools.values())}).groups == ("company",)


def test_ask_manager_opens_a_work_item_and_returns_the_formatted_answer(setup):
    store, s, parent, desk, tools = setup
    got = tools["ask_manager"]("Retry or back off?", options=["Retry", "Back off", "Stop minh"])
    assert got == 'The user chose "Back off" (option 2 of the 2 shown).'
    [q] = desk.asked
    assert (q.source, q.asker, q.node_id, q.session_id, q.run_id) == ("ask_manager", "minh", None, s.id, "run-1")
    assert q.options == ["Retry", "Back off"]
    item = store.get_work_item(q.work_item_id)
    assert (item.kind, item.requester, item.assignee, item.parent_id, item.title) == (
        "question", "minh", "ngocbh", parent.id, "Retry or back off?")
    assert (item.status, item.resolved_by) == ("done", "ngocbh")


def test_ask_manager_options_accept_any_shape(setup):
    *_, desk, tools = setup
    spec = next(s for s in group_specs({"company": tools})["company"] if s.name == "ask_manager")
    args = model_from_schema("ask_manager_args", spec.parameters)(question="q?", options={"bad": 1})
    tools["ask_manager"](**args.model_dump())
    assert desk.asked[0].options == []


@pytest.mark.parametrize("kind", ["sent_back", "interrupted"])
def test_ask_manager_closes_its_work_item_on_any_answer(store, company, kind):
    s = store.create_session(session(person="minh"))
    desk = Desk(store, None, kind=kind)
    company_tools(store, load_repo(company), s, "run-1", desk)["ask_manager"]("Deploy now?")
    assert store.get_work_item(desk.asked[0].work_item_id).status == "done"


def test_ask_manager_leaves_no_work_item_when_its_question_cannot_be_stored(store, company):
    unstored = session(person="minh")
    with pytest.raises(NotFound):
        company_tools(store, load_repo(company), unstored, "run-1", Desk(store, "x"))["ask_manager"]("Deploy now?")
    assert store.list_work_items() == []


def test_ask_manager_cancels_its_work_item_when_its_question_expires(store, company):
    s = store.create_session(session(person="minh"))
    desk = Desk(store, ...)
    desk.store.add_listener(lambda e: e.type == "question.created" and store.set_question_status(e.subject_id, "stale"))
    with pytest.raises(QuestionExpired):
        company_tools(store, load_repo(company), s, "run-1", desk)["ask_manager"]("Deploy now?")
    assert store.get_work_item(desk.asked[0].work_item_id).status == "cancelled"


def test_ask_manager_with_no_manager_is_an_error(store, company):
    s = store.create_session(session(person="ngocbh"))
    with pytest.raises(ValueError, match="no manager"):
        company_tools(store, load_repo(company), s, "run-1", Desk(store, "x"))["ask_manager"]("anyone?")


def test_create_work_item_and_comment(setup):
    store, s, parent, _, tools = setup
    out = tools["create_work_item"]("Fix the flaky test", summary="retry() flakes", assignee="minh")
    item_id = out.removeprefix("created work item ")
    item = store.get_work_item(item_id)
    assert (item.kind, item.status, item.requester, item.assignee, item.parent_id, item.summary) == (
        "task", "open", "minh", "minh", parent.id, "retry() flakes")
    assert tools["comment"](item_id, "on it") == f"commented on {item_id}"
    [c] = store.list_comments(item_id)
    assert (c.author, c.body) == ("minh", "on it")


def test_bad_arguments_are_errors_for_the_model(setup):
    *_, tools = setup
    with pytest.raises(ValueError, match="no person 'ghost'"):
        tools["create_work_item"]("x", assignee="ghost")
    with pytest.raises(ValueError, match="no work item"):
        tools["comment"]("01J9ZZZZZZZZZZZZZZZZZZZZZZ", "hi")

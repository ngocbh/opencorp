"""build: the named tool groups, each with the tools a run's ToolContext can support."""

from dataclasses import replace

import pytest

from agent_corp.company.loader import load_repo
from agent_corp.tools import ToolContext, build, toolbox, work_items, workspace
from agent_corp.tools.company import work
from agent_corp.tools.workspace import READ_TOOLS, TOOL_NAMES
from tests.store.conftest import session, work_item


def echo() -> str:
    """Echo."""
    return "echo"


class FakeMonitor:
    """The two Monitor methods tools call, recording who each binds to."""

    def __init__(self):
        self.seen = []

    def tools(self, person, *, run_id=None, session_id=None):
        self.seen.append(("tools", person, run_id, session_id))
        return {"fake__echo": echo}

    def workspace(self, tools, person, run_id, *, session_id=None):
        self.seen.append(("workspace", person, run_id, session_id))
        return lambda name, args: f"{name} ran"


@pytest.fixture
def ctx(store, company):
    item = store.create_work_item(work_item(requester="minh"))
    s = store.create_session(session(person="minh", work_item_id=item.id))
    # FakeMonitor never runs the workspace, so any non-None stands in for WorkspaceTools.
    return ToolContext(store=store, repo=load_repo(company), session=s, run_id="run-1",
                       on_question=lambda q, *, work_item=None: q, monitor=FakeMonitor(), workspace=object())


def test_build_returns_the_named_groups_in_order_with_their_tools(ctx):
    groups = build(("toolbox", "workspace", "company", "work_items"), ctx)
    assert [(g, list(t)) for g, t in groups.items()] == [
        ("toolbox", ["fake__echo"]), ("workspace", list(TOOL_NAMES)),
        ("company", ["ask_manager", "create_work_item", "comment"]),
        ("work_items", ["list_work_items", "read_work_item"])]
    assert list(build(("company", "toolbox"), ctx)) == ["company", "toolbox"]


def test_tools_are_bound_to_the_runs_person_run_and_session(ctx):
    groups = build(("toolbox", "workspace"), ctx)
    assert groups["workspace"]["read_file"]("a.py") == "read_file ran"
    assert ctx.monitor.seen == [("tools", "minh", "run-1", ctx.session.id),
                                ("workspace", "minh", "run-1", ctx.session.id)]


def test_a_read_only_run_gets_only_the_read_tools(ctx):
    assert tuple(build(("workspace",), replace(ctx, read_only=True))["workspace"]) == READ_TOOLS


# Each topic's gate: the fields its builder needs to bind its tools. A field a tool needs only
# when it is called (ask_manager's on_question) is not part of the gate.
GATES = {
    "toolbox": (toolbox.tools, {"monitor", "session"}),
    "workspace": (workspace.tools, {"monitor", "workspace", "session"}),
    "company.work": (work.tools, {"store", "repo", "session", "run_id"}),
    "work_items": (work_items.tools, {"store", "session"}),
}
FIELDS = ("store", "repo", "session", "run_id", "on_question", "carried", "monitor", "workspace", "question")


@pytest.mark.parametrize("name", GATES)
def test_a_topic_has_its_tools_with_only_what_it_needs(ctx, name):
    topic, needs = GATES[name]
    assert topic(replace(ctx, **{f: None for f in FIELDS if f not in needs}))


@pytest.mark.parametrize(("name", "field"), [(n, f) for n, (_, needs) in GATES.items() for f in sorted(needs)])
def test_a_topic_without_a_field_it_needs_has_no_tools(ctx, name, field):
    topic, _ = GATES[name]
    assert topic(replace(ctx, **{field: None})) == {}


def test_a_named_group_ctx_cant_support_is_empty_not_missing():
    assert build(("company", "workspace"), ToolContext()) == {"company": {}, "workspace": {}}


def test_an_unknown_group_raises(ctx):
    with pytest.raises(ValueError, match="unknown tool group 'nope'"):
        build(("company", "nope"), ctx)

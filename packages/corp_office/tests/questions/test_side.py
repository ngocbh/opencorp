"""A side session's run spec, its read-only lookups, and its discussion."""

import json
import os
import shutil
from importlib.resources import files

import pytest

from agent_corp.chat.harness import HarnessError
from agent_corp.company.flows import load_confined
from agent_corp.questions.side import READ_TOOLS, SIDE_CHAT_FLOW, discussion, side_spec, work_item_tools
from agent_corp.store import new_id
from tests.chat.conftest import fake_llm, make_harness, workspace  # noqa: F401
from tests.company.conftest import _isolate_git  # noqa: F401
from tests.store.conftest import message, question, session, work_item
from tests.store.conftest import store  # noqa: F401

SIDE_FLOW = (files("agent_corp.company_template") / "shared" / "flows" / "side_chat.yaml").read_text()


def side_of(h, cwd, **over):
    asker = h.store.create_session(session(cwd=str(cwd), repo_commit=h.git.head()))
    q = h.store.add_question(question(asker.id))
    return h.store.create_session(session(cwd=str(cwd), repo_commit=h.git.head(), kind="side",
                                          question_id=q.id, status="starting", **over))


def test_a_side_run_reads_the_workspace_but_cannot_change_it(make_harness, workspace):  # noqa: F811
    # minh's own harness_policy is workspace-write; a side chat is read-only anyway.
    h = make_harness(files={SIDE_CHAT_FLOW: SIDE_FLOW}, defaults={"side_seed_max_chars": 1000})
    (workspace / "notes.txt").write_text("the build is red\n")
    side = side_of(h, workspace)
    spec = side_spec(h, side)
    assert (spec.flow, spec.chat.turn, spec.learnable) == (SIDE_CHAT_FLOW, "chat/ask", False)
    assert spec.memory["session"].history_budget_chars == 1000 + 32000
    assert spec.memory["session"].storage == str(h.office.paths.run_dir(side.id) / "memory.sqlite")
    assert spec.workspace.policy.writable is False and spec.workspace.policy.network is False
    groups = spec.groups(side, "run-1", None)
    assert sorted(groups) == ["work_items", "workspace"]
    assert tuple(groups["workspace"]) == READ_TOOLS
    assert "the build is red" in groups["workspace"]["read_file"]("notes.txt")


def test_a_pin_without_the_side_chat_flow_gets_the_packaged_one(make_harness, workspace):  # noqa: F811
    h = make_harness()  # a company made before side chats existed
    side = side_of(h, workspace)
    pin = h.git.pin(side.repo_commit)
    assert not (pin / SIDE_CHAT_FLOW).exists()
    assert side_spec(h, side).flow == SIDE_CHAT_FLOW
    assert (pin / SIDE_CHAT_FLOW).read_text() == SIDE_FLOW
    assert not os.access(pin / SIDE_CHAT_FLOW, os.W_OK)
    assert load_confined(pin, pin / SIDE_CHAT_FLOW).name == "side_chat"


def test_a_pin_whose_side_chat_flow_is_not_a_file_is_refused(make_harness, workspace, tmp_path):  # noqa: F811
    h = make_harness()
    side = side_of(h, workspace)
    pin = h.git.pin(side.repo_commit)
    outside = tmp_path / "outside.yaml"
    (pin / SIDE_CHAT_FLOW).symlink_to(outside)  # a dangling link must not be written through
    with pytest.raises(HarnessError) as err:
        side_spec(h, side)
    assert (err.value.status, err.value.code) == (422, "no_side_chat_flow")
    assert not outside.exists()


@pytest.mark.parametrize("link", [SIDE_CHAT_FLOW, "shared/flows"])
def test_a_side_chat_flow_linked_from_outside_the_pin_is_refused(make_harness, workspace, tmp_path, link):  # noqa: F811
    h = make_harness()
    side = side_of(h, workspace)
    pin = h.git.pin(side.repo_commit)
    flows = tmp_path / "outside" / "flows"
    shutil.copytree(pin / "shared" / "flows", flows)  # the other flows stay reachable
    (flows / "side_chat.yaml").write_text(SIDE_FLOW)
    if link == "shared/flows":
        shutil.rmtree(pin / "shared" / "flows")
    (pin / link).symlink_to(flows / "side_chat.yaml" if link == SIDE_CHAT_FLOW else flows)
    with pytest.raises(HarnessError) as err:
        side_spec(h, side)
    assert (err.value.status, err.value.code) == (422, "no_side_chat_flow")


def test_a_side_run_in_the_office_files_is_refused(make_harness):  # noqa: F811
    h = make_harness(files={SIDE_CHAT_FLOW: SIDE_FLOW})
    with pytest.raises(HarnessError) as err:
        side_spec(h, side_of(h, h.office.paths.company))
    assert (err.value.status, err.value.code) == (422, "unsafe_workspace")


def test_work_item_tools_show_only_what_the_asker_can_see(store):  # noqa: F811
    top = store.create_work_item(work_item(title="Ship v2"))
    chat = store.create_work_item(work_item(title="Chat", parent_id=top.id))
    sibling = store.create_work_item(work_item(title="Docs", parent_id=top.id))
    mine = store.create_work_item(work_item(title="Mine", requester="ngocbh", assignee="minh"))
    other = store.create_work_item(work_item(title="Someone else's", assignee="lan"))
    asker = store.create_session(session(work_item_id=chat.id))
    q = store.add_question(question(asker.id))
    tools = work_item_tools(store, "minh", q)
    listed = {i["title"] for i in json.loads(tools["list_work_items"]())}
    assert listed == {"Ship v2", "Chat", "Docs", "Mine"}
    read = json.loads(tools["read_work_item"](top.id))
    assert read["title"] == "Ship v2" and {c["title"] for c in read["children"]} == {"Chat", "Docs"}
    assert json.loads(tools["read_work_item"](sibling.id))["parent_id"] == top.id
    assert json.loads(tools["read_work_item"](mine.id))["title"] == "Mine"
    for hidden in (other.id, new_id()):
        with pytest.raises(ValueError, match="no work item"):
            tools["read_work_item"](hidden)


def text(t):
    return {"id": new_id(), "type": "text", "text": t}


def tool():
    return {"id": new_id(), "type": "tool", "call_id": "c1", "tool": "read_file", "state": "completed",
            "input": {"path": "a"}, "output": "secret file text"}


def test_the_discussion_is_human_messages_and_final_reply_text(store):  # noqa: F811
    side = store.create_session(session(kind="side", status="idle"))
    store.add_message(message(side.id, [text("why not fail fast?")], role="user"))
    store.add_message(message(side.id, [text("Let me look."), tool(), text("The sandbox is rate-limited.")]))
    store.add_message(message(side.id, [text("ok"), text("and retries?")], role="user"))
    store.add_message(message(side.id, [tool()]))  # a reply that was stopped before any text
    assert [(e.role, e.text) for e in discussion(store, side.id)] == [
        ("user", "why not fail fast?"), ("assistant", "The sandbox is rate-limited."), ("user", "ok\n\nand retries?")]


def test_a_reply_still_running_is_not_in_the_discussion(store):  # noqa: F811
    side = store.create_session(session(kind="side", status="busy"))
    store.add_message(message(side.id, [text("why?")], role="user"))
    store.add_message(message(side.id, [text("Because")]))
    assert [e.role for e in discussion(store, side.id)] == ["user"]
    # The next turn is stored before the session turns idle: the reply is final by then.
    store.add_question(question(side.id, source="human_input", node_id="chat#2/ask", question="You:"))
    assert [e.role for e in discussion(store, side.id)] == ["user", "assistant"]

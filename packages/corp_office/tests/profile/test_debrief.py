from importlib.resources import files

import pytest

from agent_corp.company.flows import load_confined
from agent_corp.profile.debrief import (DEBRIEF_FLOW, confirm_follow_ups, pending_debrief, ready_debrief,
                                        transcript_text)
from agent_corp.protocol import now
from agent_corp.protocol.models import Message, TextPart, ToolPart
from agent_corp.store import new_id
from tests.store.conftest import session, store, work_item  # noqa: F401

OUTPUT = {"summary": "Fixed the bug.", "status": "done", "artifacts": ["PR #4"], "decisions": ["Use sqlite"],
          "follow_ups": ["Add a test", " ", "Update the docs"], "open_questions": []}


def test_the_debrief_template_loads():
    root = files("agent_corp.company_template")
    flow = load_confined(root, root / DEBRIEF_FLOW)
    assert flow.name == "debrief"


def test_the_flow_output_is_a_ready_debrief():
    s = session(status="debriefing", cost=0.25)
    debrief = ready_debrief(s, OUTPUT)
    assert debrief.state == "ready" and debrief.summary == "Fixed the bug." and debrief.cost == 0.25
    assert [(f.text, f.confirmed, f.work_item_id) for f in debrief.follow_ups] == [
        ("Add a test", False, None), ("Update the docs", False, None)]
    assert pending_debrief(s).model_dump(exclude={"updated_at"}) == {
        "session_id": s.id, "state": "pending", "summary": None, "status": None, "artifacts": [], "decisions": [],
        "follow_ups": [], "open_questions": [], "cost": 0.25}


def _message(role, *parts):
    return Message(id=new_id(), session_id=new_id(), role=role, parts=list(parts), created_at=now())


def _text(text):
    return TextPart(id=new_id(), type="text", text=text)


def test_the_transcript_is_the_text_of_each_message_and_the_tools_called():
    tool = ToolPart(id=new_id(), type="tool", call_id="c1", tool="shell", state="completed", input={"cmd": "ls"})
    text = transcript_text([_message("user", _text("fix it")), _message("assistant", tool, _text("Done."))])
    assert text == "user: fix it\n\nassistant: [called shell]\nDone."


def test_a_long_transcript_keeps_its_end():
    messages = [_message("user", _text(f"message {i}")) for i in range(100)]
    text = transcript_text(messages, max_chars=60)
    assert text.startswith("[earlier messages left out]") and text.endswith("user: message 99")
    assert len(text) <= 60 + len("[earlier messages left out]\n\n")


def test_a_last_message_longer_than_the_budget_keeps_its_end():
    last = "x" * 50 + "the end"
    text = transcript_text([_message("user", _text("fix it")), _message("assistant", _text(last))], max_chars=20)
    assert text == "[earlier messages left out]\n\n[the start of this message left out]" + ("x" * 50 + "the end")[-20:]
    alone = transcript_text([_message("assistant", _text(last))], max_chars=20)
    assert alone == "[the start of this message left out]" + last[-20:]


def test_confirming_follow_ups_makes_one_work_item_each_once(store):
    s = store.create_session(session(status="ended", work_item_id=store.create_work_item(work_item()).id))
    store.save_debrief(ready_debrief(s, OUTPUT))
    debrief = confirm_follow_ups(store, s, [1], requester="ngocbh")
    again = confirm_follow_ups(store, s, [0, 1], requester="ngocbh")
    assert [f.confirmed for f in debrief.follow_ups] == [False, True]
    assert [f.confirmed for f in again.follow_ups] == [True, True]
    assert again.follow_ups[1].work_item_id == debrief.follow_ups[1].work_item_id
    items = [store.get_work_item(f.work_item_id) for f in again.follow_ups]
    assert [(w.title, w.kind, w.status, w.requester, w.assignee, w.parent_id) for w in items] == [
        ("Add a test", "task", "open", "ngocbh", "minh", s.work_item_id),
        ("Update the docs", "task", "open", "ngocbh", "minh", s.work_item_id)]
    assert store.get_debrief(s.id) == again


def test_confirming_an_index_out_of_range_changes_nothing(store):
    s = store.create_session(session(status="ended"))
    store.save_debrief(ready_debrief(s, OUTPUT))
    with pytest.raises(IndexError, match="no follow-up 2"):
        confirm_follow_ups(store, s, [0, 2], requester="ngocbh")
    assert not any(f.confirmed for f in store.get_debrief(s.id).follow_ups)
    assert store.list_work_items() == []


def test_a_pending_debrief_has_nothing_to_confirm(store):
    s = store.create_session(session(status="ended"))
    store.save_debrief(pending_debrief(s))
    with pytest.raises(LookupError, match="not ready"):
        confirm_follow_ups(store, s, [0], requester="ngocbh")

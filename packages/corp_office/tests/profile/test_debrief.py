from importlib.resources import files

import pytest

from agent_corp.company.flows import load_confined
from agent_corp.harness.translate import COMMAND, FILE_CHANGE, MCP_TOOL, REQUEST
from agent_corp.profile.debrief import (DEBRIEF_FLOW, apprentice_header, confirm_follow_ups, pending_debrief,
                                        ready_debrief, transcript_text)
from agent_corp.protocol import now
from agent_corp.protocol.models import ErrorPart, Message, TextPart, ToolPart
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


def _message(role, *parts, **over):
    return Message(id=new_id(), session_id=new_id(), role=role, parts=list(parts), created_at=now(), **over)


def _text(text):
    return TextPart(id=new_id(), type="text", text=text)


def test_the_transcript_is_the_text_of_each_message_and_the_tools_called():
    tool = ToolPart(id=new_id(), type="tool", call_id="c1", tool="shell", state="completed", input={"cmd": "ls"})
    text = transcript_text([_message("user", _text("fix it")), _message("assistant", tool, _text("Done."))])
    assert text == "user: fix it\n\nassistant: [called shell]\nDone."


def test_messages_with_an_author_read_as_at_author_and_the_assistant_label_can_change():
    text = transcript_text([_message("user", _text("fix it"), author="ngocbh"), _message("assistant", _text("On it."))],
                           assistant="codex")
    assert text == "@ngocbh: fix it\n\ncodex: On it."


def _codex(name, **input):
    return ToolPart(id=new_id(), type="tool", call_id="c", tool=name, state="completed", input=input)


def test_codex_tool_parts_are_summarized_with_who_decided():
    approved = {"decision": "accept", "by": "ngocbh"}
    parts = [_codex(COMMAND, command="pytest -q", exit_code=1, approval=approved),
             _codex(FILE_CHANGE, changes=[{"path": "a.py", "kind": "update", "diff": "@@ -1 +1,2 @@\n+x\n+y\n-z\n"}]),
             _codex(MCP_TOOL, server="docs", tool="search", arguments={}),
             _codex(REQUEST, kind="permissions", summary="network", approval={"decision": "decline", "by": "ngocbh"})]
    assert transcript_text([_message("assistant", *parts)], assistant="codex").splitlines() == [
        "codex: $ pytest -q (exit 1) [accept by @ngocbh]", "edited a.py (+2/-1)", "[mcp docs/search]",
        "[asked: permissions: network] [decline by @ngocbh]"]


def test_codex_new_deleted_and_moved_files_say_so():
    # Codex sends a new or deleted file's content as its diff, with no +/- markers.
    part = _codex(FILE_CHANGE, changes=[{"path": "new.md", "kind": "add", "diff": "one\ntwo\n"},
                                        {"path": "old.md", "kind": "delete", "diff": "gone\n"},
                                        {"path": "a.py", "kind": "update", "move_path": "b.py", "diff": ""}])
    assert transcript_text([_message("assistant", part)], assistant="codex") == (
        "codex: edited new.md (added, +2/-0), old.md (deleted, +0/-1), a.py → b.py (+0/-0)")


def test_a_multi_line_codex_command_reads_as_one_line_with_its_decision():
    command = "cat > a.md <<'EOF'\none\ntwo\nEOF"
    part = _codex(COMMAND, command=command, exit_code=0, approval={"decision": "accept", "by": "ngocbh"})
    assert transcript_text([_message("assistant", part)], assistant="codex") == (
        "codex: $ cat > a.md <<'EOF' one two EOF (exit 0) [accept by @ngocbh]")


def test_a_codex_decision_with_no_one_named_reads_without_a_name():
    part = _codex(COMMAND, command="ls", exit_code=0, approval={"decision": "accept", "by": None})
    assert transcript_text([_message("assistant", part)], assistant="codex") == "codex: $ ls (exit 0) [accept]"


def test_an_unknown_codex_tool_reads_as_called():
    part = _codex("codex.web_search", query="sqlite")
    assert transcript_text([_message("assistant", part)], assistant="codex") == "codex: [called codex.web_search]"


def test_a_long_codex_command_summary_is_capped():
    line = transcript_text([_message("assistant", _codex(COMMAND, command="x" * 1000, exit_code=0))])
    assert len(line) < 400 and line.endswith("…")


def test_the_transcript_says_where_a_turn_failed():
    error = ErrorPart(id=new_id(), type="error", message="The reply failed. Send your message again.")
    text = transcript_text([_message("user", _text("fix it")), _message("assistant", error)])
    assert text == "user: fix it\n\nassistant: [error: The reply failed. Send your message again.]"


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


def test_the_apprentice_header_names_driver_employee_and_folder():
    header = apprentice_header(owner="ngocbh", employee="minh", cwd="/w/app")
    assert header.startswith("In this session @ngocbh drove Codex (an AI coding agent) in `/w/app`; you, @minh, "
                             "watched as an apprentice.")
    assert "instructions above" in header and "their approvals" in header


def test_the_apprentice_header_with_no_known_owner_names_none():
    header = apprentice_header(owner=None, employee="minh", cwd="/w")
    assert header.startswith("In this session the owner drove Codex (an AI coding agent) in `/w`; you, @minh, ")
    assert "@None" not in header and "how the owner worked" in header


def test_the_header_survives_the_cut_and_counts_against_the_budget():
    header = apprentice_header(owner="ngocbh", employee="minh", cwd="/w")
    messages = [_message("user", _text(f"message {i}"), author="ngocbh") for i in range(200)]
    text = transcript_text(messages, max_chars=len(header) + 80, assistant="codex", header=header)
    assert text.startswith(header + "\n\n[earlier messages left out]") and text.endswith("@ngocbh: message 199")
    assert len(text) <= len(header) + 80 + len("\n\n[earlier messages left out]")


def test_a_header_longer_than_the_budget_leaves_no_message_text():
    header = "h" * 50
    text = transcript_text([_message("user", _text("fix it")), _message("assistant", _text("x" * 100))], max_chars=10,
                           header=header)
    assert text == header + "\n\n[earlier messages left out]\n\n[the start of this message left out]"


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

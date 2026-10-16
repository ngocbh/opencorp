"""Codex items as transcript parts, and server requests as cards with their replies."""

import json
from pathlib import Path

import pytest

from agent_corp.chat.transcript import Transcript
from agent_corp.harness.translate import (COMMAND, FILE_CHANGE, MCP_TOOL, OUTPUT_CUT, OUTPUT_MAX_CHARS, Translator,
                                          change_counts, relative)
from agent_corp.store import Store
from agent_corp.testing import fake_codex as fc
from tests.store.conftest import session

FIXTURES = Path(__file__).parent / "fixtures" / "codex"


@pytest.fixture
def tr(tmp_path):
    store = Store(tmp_path / "store.sqlite")
    # "/w" is what feed fills {cwd} with.
    s = store.create_session(session(harness="codex", work_item_id=None, cwd="/w"))
    yield store, s, Translator(Transcript(store, s.id, lambda e: None), s.cwd)
    store.close()


def feed(translator, steps, turn="turn_1"):
    """Hand each notification step to the translator, as the session would."""
    for step in steps:
        if "notify" in step:
            translator.notification(step["notify"], fc.fill(step["params"], turn, "/w", "thr_1"))


def parts(store, sid):
    return [p for m in store.list_messages(sid) for p in m.parts]


def shape(store, sid):
    """Each message's role and its parts as text, or (tool, state)."""
    return [(m.role, [p.text if p.type == "text" else (p.tool, p.state) if p.type == "tool" else p.type
                      for p in m.parts]) for m in store.list_messages(sid)]


def card(t, s, step, run_id="turn_1"):
    params = fc.fill(step["params"], run_id, "/w", "thr_1")
    return t.card(step["request"], params, session=s, run_id=run_id, node_id=str(step["id"]))


# --- text, deltas, reasoning, turn ends and errors ---------------------------------------

def test_an_agent_message_streams_into_one_text_part(tr):
    store, s, t = tr
    feed(t, fc.agent_message("m1", "Hello there"))
    t.turn_completed("turn_1", "completed", None)
    [message] = store.list_messages(s.id)
    assert message.role == "assistant" and [p.text for p in message.parts] == ["Hello there"]


def test_a_message_completed_without_deltas_still_shows(tr):
    store, s, t = tr
    t.notification("item/completed", {"turnId": "turn_1", "item": {"type": "agentMessage", "id": "m1", "text": "Hi"}})
    t.turn_completed("turn_1", "completed", None)
    assert [p.text for p in parts(store, s.id)] == ["Hi"]


def test_reasoning_summaries_show_as_thinking_text(tr):
    store, s, t = tr
    t.notification("item/completed", {"turnId": "turn_1", "item": {"type": "reasoning", "id": "r1",
                                                                    "summary": ["Check the tests first."]}})
    t.turn_completed("turn_1", "completed", None)
    assert [p.text for p in parts(store, s.id)] == ["(thinking) Check the tests first."]


def test_an_interrupted_turn_ends_with_the_marker_even_with_no_items(tr):
    store, s, t = tr
    t.turn_completed("turn_1", "interrupted", None)
    assert [p.text for p in parts(store, s.id)] == ["[interrupted]"]


def test_a_failed_turn_adds_its_error(tr):
    store, s, t = tr
    feed(t, fc.agent_message("m1", "Trying"))
    t.turn_completed("turn_1", "failed", {"message": "usage limit reached"})
    assert [p.message for p in parts(store, s.id) if p.type == "error"] == [
        "Codex's turn failed: usage limit reached"]


def test_errors_codex_retries_are_not_shown_and_a_failure_it_already_said_shows_once(tr):
    store, s, t = tr
    feed(t, [fc.error("rate limited, retrying", will_retry=True), fc.error("stream broke", will_retry=False)])
    t.turn_completed("turn_1", "failed", {"message": "stream broke"})
    feed(t, [fc.error("disk full", will_retry=False)], turn="turn_2")
    t.turn_completed("turn_2", "failed", {"message": "usage limit reached"})
    assert [p.message for p in parts(store, s.id) if p.type == "error"] == [
        "Codex: stream broke", "Codex: disk full", "Codex's turn failed: usage limit reached"]


def test_items_share_one_message_and_one_that_starts_after_a_steer_opens_the_next(tr):
    store, s, t = tr
    feed(t, fc.agent_message("m1", "One."))
    t.transcript.user("and also", author="ngocbh")
    feed(t, fc.agent_message("m2", "Two."))
    t.turn_completed("turn_1", "completed", None)
    assert shape(store, s.id) == [("assistant", ["One."]), ("user", ["and also"]), ("assistant", ["Two."])]


def test_a_steer_mid_stream_leaves_the_streaming_text_in_its_message(tr):
    store, s, _ = tr
    live = []
    t = Translator(Transcript(store, s.id, live.append))
    steps = fc.agent_message("m1", "Hello there")
    feed(t, steps[:2])  # started, and the first delta
    t.transcript.user("stop at 5", author="ngocbh")
    feed(t, [*steps[2:], *fc.agent_message("m2", "Stopping at 5.")])
    t.turn_completed("turn_1", "completed", None)
    assert shape(store, s.id) == [("assistant", ["Hello there"]), ("user", ["stop at 5"]),
                                  ("assistant", ["Stopping at 5."])]
    first, _, third = store.list_messages(s.id)
    deltas = [(e.data["part_id"], e.data["message_id"]) for e in live if e.type == "part.delta"]
    assert {m for p, m in deltas if p == first.parts[0].id} == {first.id}
    assert {m for p, m in deltas if p == third.parts[0].id} == {third.id}


def test_a_steer_mid_stream_then_an_interrupt_keeps_the_text_whole_and_marks_after_the_steer(tr):
    store, s, t = tr
    steps = fc.agent_message("m1", "Hello there")
    feed(t, steps[:2])
    t.transcript.user("stop", author="ngocbh")
    feed(t, [steps[2]])
    t.turn_completed("turn_1", "interrupted", None)
    assert shape(store, s.id) == [("assistant", ["Hello there"]), ("user", ["stop"]), ("assistant", ["[interrupted]"])]


def test_an_error_mid_turn_puts_what_follows_below_it(tr):
    store, s, t = tr
    feed(t, [*fc.agent_message("m1", "One."), fc.error("hiccup", will_retry=False), *fc.agent_message("m2", "Two.")])
    t.turn_completed("turn_1", "completed", None)
    assert shape(store, s.id) == [("assistant", ["One."]), ("assistant", ["error"]), ("assistant", ["Two."])]


# --- tool items --------------------------------------------------------------------------

def test_a_command_is_a_tool_part_with_its_exit_code_and_capped_output(tr):
    store, s, t = tr
    feed(t, fc.command("c1", "pytest -q", output="x" * (OUTPUT_MAX_CHARS + 10), exit_code=1))
    t.turn_completed("turn_1", "completed", None)
    [part] = parts(store, s.id)
    assert (part.tool, part.state, part.input["command"], part.input["exit_code"]) == (COMMAND, "completed",
                                                                                        "pytest -q", 1)
    assert part.output.endswith(OUTPUT_CUT) and len(part.output) == OUTPUT_MAX_CHARS + len(OUTPUT_CUT)


def test_a_file_change_keeps_paths_kinds_and_diffs(tr):
    store, s, t = tr
    feed(t, fc.file_change("f1", "notes.md", "hi\n"))
    t.turn_completed("turn_1", "completed", None)
    [part] = parts(store, s.id)
    assert part.tool == FILE_CHANGE and part.input["changes"] == [{"path": "notes.md", "kind": "add", "diff": "hi\n"}]


def test_a_file_change_under_the_cwd_is_named_relative_to_it(tr):
    # Codex sends absolute paths; the owner reads them as the project's.
    store, s, t = tr
    feed(t, [*fc.file_change("f1", "{cwd}/docs/notes.md", "hi\n"), *fc.file_change("f2", "/etc/hosts", "x\n")])
    t.turn_completed("turn_1", "completed", None)
    assert [p.input["changes"][0]["path"] for p in parts(store, s.id)] == ["docs/notes.md", "/etc/hosts"]
    assert relative("/w", "/w") == "/w" and relative("/wx/a", "/w") == "/wx/a" and relative("a.py", "/w") == "a.py"


@pytest.mark.parametrize(("kind", "diff", "counts"), [
    ("add", "one\ntwo\n", (2, 0)),                       # Codex sends a new file's content
    ("delete", "one\n+two\n-three\n", (0, 3)),            # and a deleted file's content
    ("update", "@@ -1,2 +1,2 @@\n-z\n+x\n+y\n keep\n", (2, 1)),
    ("update", "@@ -1 +1 @@\n-a\n+b\n\n\nMoved to: b.py", (1, 1)),
])
def test_a_file_changes_lines_are_counted_by_its_kind(kind, diff, counts):
    assert change_counts(kind, diff) == counts


def test_a_declined_command_is_an_error_part_and_a_running_one_is_interrupted_at_turn_end(tr):
    store, s, t = tr
    feed(t, [fc.command("c1", "rm -rf build", status="declined", exit_code=None)[1]])
    feed(t, [fc.command_started("c2", "sleep 9")])
    t.turn_completed("turn_1", "interrupted", None)
    states = {p.input["command"]: (p.state, p.error) for p in parts(store, s.id) if p.type == "tool"}
    assert states == {"rm -rf build": ("error", "declined"), "sleep 9": ("interrupted", None)}


def test_an_mcp_call_names_server_and_tool(tr):
    store, s, t = tr
    t.notification("item/completed", {"turnId": "turn_1", "item": {
        "type": "mcpToolCall", "id": "x1", "server": "docs", "tool": "search", "status": "completed",
        "arguments": {"q": "launchd"}, "result": {"content": [{"type": "text", "text": "3 hits"}]}, "error": None}})
    t.turn_completed("turn_1", "completed", None)
    [part] = parts(store, s.id)
    assert part.tool == MCP_TOOL and part.input == {"server": "docs", "tool": "search", "arguments": {"q": "launchd"}}
    assert "3 hits" in part.output


def test_a_steer_while_a_command_runs_completes_its_part_in_place(tr):
    store, s, t = tr
    feed(t, [fc.command_started("c1", "sleep 3")])
    t.transcript.user("also b", author="ngocbh")
    feed(t, [fc.command("c1", "sleep 3")[1], *fc.agent_message("m1", "Slept.")])
    t.turn_completed("turn_1", "completed", None)
    assert shape(store, s.id) == [("assistant", [(COMMAND, "completed")]), ("user", ["also b"]),
                                  ("assistant", ["Slept."])]


def test_two_steers_around_a_running_command_keep_it_in_its_message(tr):
    store, s, t = tr
    feed(t, [fc.command_started("c1", "sleep 3")])
    t.transcript.user("a", author="ngocbh")
    feed(t, fc.agent_message("m1", "One."))
    t.transcript.user("b", author="ngocbh")
    feed(t, [fc.command("c1", "sleep 3")[1], *fc.agent_message("m2", "Two.")])
    t.turn_completed("turn_1", "completed", None)
    assert shape(store, s.id) == [("assistant", [(COMMAND, "completed")]), ("user", ["a"]), ("assistant", ["One."]),
                                  ("user", ["b"]), ("assistant", ["Two."])]


def test_a_running_command_from_before_a_steer_is_interrupted_with_the_turn(tr):
    store, s, t = tr
    feed(t, [fc.command_started("c1", "sleep 30")])
    t.transcript.user("never mind", author="ngocbh")
    t.turn_completed("turn_1", "interrupted", None)
    assert shape(store, s.id) == [("assistant", [(COMMAND, "interrupted")]), ("user", ["never mind"]),
                                  ("assistant", ["[interrupted]"])]


# --- approval cards ----------------------------------------------------------------------

def test_a_command_approval_offers_the_four_decisions_and_replies_with_the_picked_one(tr):
    store, s, t = tr
    feed(t, [fc.command_started("c1", "touch a")])
    c = card(t, s, fc.command_approval(1, "c1", "touch a"))
    q = c.question
    assert (c.kind, q.source, q.run_id, q.node_id, q.asker) == ("command", "harness", "turn_1", "1", s.person)
    assert q.options == ["Approve", "Approve for this session", "Deny so Codex continues", "Deny and stop"]
    assert "$ touch a" in q.question
    assert c.reply("Approve for this session") == ({"decision": "acceptForSession"}, "acceptForSession")


def test_only_offered_decisions_show_and_persistent_ones_never_do(tr):
    store, s, t = tr
    step = fc.command_approval(1, "c1", "curl x")
    step["params"]["availableDecisions"] = ["accept", {"acceptWithExecpolicyAmendment": {}}, "cancel"]
    assert card(t, s, step).question.options == ["Approve", "Deny and stop"]


@pytest.mark.parametrize(("kind", "diff", "says"), [
    ("add", "hi\nthere\n", "notes.md (add, +2/-0)"),
    ("delete", "a\nb\nc\n", "notes.md (delete, +0/-3)"),
    ("update", "@@ -1 +1,2 @@\n-z\n+x\n+y\n", "notes.md (update, +2/-1)"),
])
def test_a_file_change_card_counts_lines_by_kind(tr, kind, diff, says):
    store, s, t = tr
    feed(t, [fc.file_change("f1", "{cwd}/notes.md", diff, kind=kind)[0]])  # an absolute path, as Codex sends
    c = card(t, s, fc.file_change_approval(2, "f1"))
    assert c.kind == "file_change" and says in c.question.question
    assert c.reply("Deny so Codex continues") == ({"decision": "decline"}, "decline")


def test_a_network_approval_names_the_host(tr):
    # Codex sends a managed-network approval with no command or cwd, only networkApprovalContext.
    store, s, t = tr
    c = card(t, s, fc.network_approval(7, "c2", "pypi.org"))
    assert (c.kind, c.question.title, c.question.question) == ("command", "Codex wants network access",
                                                               "https to pypi.org")
    assert c.reply("Approve") == ({"decision": "accept"}, "accept")


def test_a_permissions_card_grants_what_was_asked_for_this_turn_or_session_or_nothing(tr):
    store, s, t = tr
    c = card(t, s, fc.permissions_approval(3, "p1"))
    assert c.kind == "permissions"
    assert c.question.options == ["Approve for this turn", "Approve for this session", "Deny"]
    assert c.reply("Approve for this turn") == ({"permissions": {"network": {"enabled": True}}, "scope": "turn"},
                                                "turn")
    assert c.reply("Deny") == ({"permissions": {}, "scope": "turn"}, "decline")

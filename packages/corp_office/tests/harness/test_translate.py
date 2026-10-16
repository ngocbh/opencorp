"""Codex items as transcript parts, and server requests as cards with their replies."""

import json
import os
import threading
from pathlib import Path

import pytest
from jsonschema import Draft7Validator

from agent_corp.chat.transcript import Transcript
from agent_corp.harness.translate import (COMMAND, FILE_CHANGE, MCP_TOOL, OUTPUT_CUT, OUTPUT_MAX_CHARS, REFUSED,
                                          REPLY_SCHEMAS, SERVED, Translator, Unserved, change_counts, relative)
from agent_corp.store import Store
from agent_corp.testing import fake_codex as fc
from tests.store.conftest import session

FIXTURES = Path(__file__).parent / "fixtures" / "codex"
RECORDED = sorted((FIXTURES / "sessions").glob("*.jsonl"))
SPIKE = json.loads((FIXTURES / "spike.json").read_text())


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


def reply_validator(method):
    return Draft7Validator(json.loads((FIXTURES / "schema" / f"{REPLY_SCHEMAS[method]}.json").read_text()))


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


def test_a_completed_message_adds_only_what_the_deltas_left_out(tr):
    store, s, t = tr
    feed(t, [fc.agent_message_delta("m1", "Hello w")])
    t.notification("item/completed", {"turnId": "turn_1", "item": {"type": "agentMessage", "id": "m1",
                                                                    "text": "Hello world, done."}})
    feed(t, [fc.agent_message_delta("m2", "Hello wrld")])  # deltas that don't lead to the final text
    t.notification("item/completed", {"turnId": "turn_1", "item": {"type": "agentMessage", "id": "m2",
                                                                    "text": "Hello world, done."}})
    t.turn_completed("turn_1", "completed", None)
    assert [p.text for p in parts(store, s.id)] == ["Hello world, done.", "Hello wrld"]


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


def test_a_long_session_keeps_nothing_from_its_finished_turns(tr):
    store, s, t = tr
    for n in range(1, 6):
        turn = f"turn_{n}"
        feed(t, [*fc.command("c", "true"), fc.command_started(f"c{n}", "sleep 9"), *fc.agent_message(f"m{n}", "Hi")[:2],
                 fc.error("hiccup", will_retry=False)], turn=turn)
        t.turn_completed(turn, "interrupted" if n % 2 else "failed", {"message": "hiccup"})
        feed(t, [fc.error("late", will_retry=False)], turn=turn)  # after its turn ended: nothing to keep
    assert (t._items, t._streamed, t._nodes, t._segments, t._shown, t._after_error) == ({}, {}, {}, {}, {}, set())
    assert [p.message for p in parts(store, s.id) if p.type == "error"] == ["Codex: hiccup"] * 5


def test_a_turns_end_from_another_thread_waits_for_a_notification_being_written(tr):
    # The session hands notifications over on Codex's reader thread and ends turns from others.
    store, s, _ = tr
    writing, release = threading.Event(), threading.Event()

    class Slow(Transcript):
        def stream(self, frame):
            writing.set()
            release.wait(5)
            super().stream(frame)

    t = Translator(Slow(store, s.id, lambda e: None), s.cwd)
    delta = threading.Thread(target=feed, args=(t, [fc.agent_message_delta("m1", "Hi")]))
    end = threading.Thread(target=t.turn_completed, args=("turn_1", "interrupted", None))
    delta.start()
    assert writing.wait(5)
    end.start()
    end.join(0.2)
    assert end.is_alive()  # it waits for the delta, so the delta never lands in a closed message
    release.set()
    delta.join(5)
    end.join(5)
    assert shape(store, s.id) == [("assistant", ["Hi\n\n[interrupted]"])]


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


def test_a_moved_file_keeps_where_it_moved_to_on_its_part_and_card(tr):
    store, s, t = tr
    steps = fc.file_change("f1", "{cwd}/a.py", "@@ -1 +1 @@\n-a\n+b\n\n\nMoved to: {cwd}/b.py", kind="update")
    for step in steps:
        step["params"]["item"]["changes"][0]["kind"]["move_path"] = "{cwd}/b.py"
    feed(t, steps[:1])
    assert "a.py → b.py (update, +1/-1)" in card(t, s, fc.file_change_approval(2, "f1")).question.question
    feed(t, steps[1:])
    t.turn_completed("turn_1", "completed", None)
    [change] = parts(store, s.id)[0].input["changes"]
    assert (change["path"], change["move_path"], change["kind"]) == ("a.py", "b.py", "update")


@pytest.mark.parametrize(("kind", "diff", "counts"), [
    ("add", "one\ntwo\n", (2, 0)),                       # Codex sends a new file's content
    ("delete", "one\n+two\n-three\n", (0, 3)),            # and a deleted file's content
    ("update", "@@ -1,2 +1,2 @@\n-z\n+x\n+y\n keep\n", (2, 1)),
    ("update", "@@ -1 +1 @@\n-a\n+b\n\n\nMoved to: b.py", (1, 1)),
    ("update", "--- a/f\n+++ b/f\n@@ -1 +1 @@\n--- x\n+++ y\n", (1, 1)),  # headers, then lines "-- x" and "++ y"
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


def test_a_command_approval_names_the_permissions_it_asks_for(tr):
    store, s, t = tr
    step = fc.command_approval(1, "c1", "make out")
    step["params"]["additionalPermissions"] = {"network": {"enabled": True},
                                               "fileSystem": {"write": ["/w/out"], "read": None, "entries": None}}
    lines = card(t, s, step).question.question.splitlines()
    assert lines == ["$ make out", "in /w",
                     'and asks for {"network": {"enabled": true}, "fileSystem": {"write": ["/w/out"]}}']


def test_input_to_a_running_command_is_titled_as_such(tr):
    store, s, t = tr
    step = fc.command_approval(1, "c1", "python3")
    step["params"]["kind"] = "writeStdin"
    assert card(t, s, step).question.title == "Codex wants to send input to a running command"
    step["params"]["kind"] = "command"
    assert card(t, s, step).question.title == "Codex wants to run a command"


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


# --- question, MCP and elicitation cards -------------------------------------------------

def test_codex_questions_are_pages_with_secret_ones_marked(tr):
    store, s, t = tr
    step = fc.user_input(4, "u1", [fc.question("token", "Token", "Paste it", secret=True),
                                   fc.question("env", "Env", "Where?", options=["prod", "dev"])])
    c = card(t, s, step)
    assert c.kind == "question" and [p.header for p in c.question.questions] == ["Token", "Env"]
    assert [p.secret for p in c.question.questions] == [True, False] and c.secret == {"Token"}
    assert [f.name for f in c.question.answer_schema] == ["Env"]  # no "other": only its options
    assert c.reply({"Token": "s3cret", "Env": "dev"}) == (
        {"answers": {"token": {"answers": ["s3cret"]}, "env": {"answers": ["dev"]}}}, "answer")


@pytest.mark.parametrize("form", ["elicitation", "user_input"])
def test_an_mcp_tool_approval_is_one_card_in_either_wire_form(tr, form):
    store, s, t = tr
    step = (fc.mcp_approval(5, "docs", "search") if form == "elicitation"
            else fc.mcp_approval_question(5, "u2", "docs", "search"))
    c = card(t, s, step)
    assert c.kind == "mcp_tool" and c.question.options == ["Allow", "Allow for this session", "Cancel"]
    if form == "elicitation":
        assert c.question.title == "Codex wants to use an MCP tool"
        assert c.reply("Allow for this session") == ({"action": "accept", "_meta": {"persist": "session"}},
                                                     "acceptForSession")
        assert c.reply("Cancel") == ({"action": "cancel"}, "cancel")
    else:
        assert c.reply("Allow") == ({"answers": {"mcp_tool_call_approval_1": {"answers": ["Allow"]}}}, "accept")


def test_an_mcp_approval_without_a_session_choice_offers_two(tr):
    store, s, t = tr
    step = fc.mcp_approval(5, "docs", "search", session_option=False)
    assert card(t, s, step).question.options == ["Allow", "Cancel"]


def test_other_elicitations_are_cards_too(tr):
    store, s, t = tr
    url = {"request": "mcpServer/elicitation/request", "id": 6, "params": {
        "serverName": "gh", "threadId": "{thread}", "turnId": None, "mode": "url", "elicitationId": "e1",
        "message": "Sign in to GitHub", "url": "https://example.com/login"}}
    c = card(t, s, url, run_id="codex-123")
    assert c.kind == "elicitation" and "https://example.com/login" in c.question.question
    assert c.question.options == ["Done", "Decline", "Cancel"] and c.reply("Done") == ({"action": "accept"}, "accept")
    form = {"request": "mcpServer/elicitation/request", "id": 7, "params": {
        "serverName": "jira", "threadId": "{thread}", "turnId": "{turn}", "mode": "form", "message": "Ticket details",
        "requestedSchema": {"type": "object", "properties": {
            "priority": {"type": "string", "enum": ["low", "high"]}, "points": {"type": "integer"},
            "urgent": {"type": "boolean"}}}}}
    c = card(t, s, form)
    assert [p.header for p in c.question.questions] == ["priority", "points", "urgent"]
    # A number field is typed, so check_answer converts "3" or refuses "x" before the store or Codex sees it.
    assert [(f.name, f.type, f.enum) for f in c.question.answer_schema] == [
        ("priority", "str", ["low", "high"]), ("points", "int", None), ("urgent", "str", ["Yes", "No"])]
    assert c.reply({"priority": "high", "points": 3, "urgent": "Yes"}) == (
        {"action": "accept", "content": {"priority": "high", "points": 3, "urgent": True}}, "accept")


@pytest.mark.parametrize("properties", [
    {f"f{i}": {"type": "string"} for i in range(5)},  # more fields than a card has pages
    {"tags": {"type": "array", "items": {"type": "string", "enum": ["a", "b"]}}},  # a list, which a page can't give
    {"env": {"type": "string", "oneOf": [{"const": "p", "title": "Prod"}]}},  # titled choices, whose values differ
])
def test_a_form_a_card_cannot_answer_in_full_is_unserved(tr, properties):
    store, s, t = tr
    with pytest.raises(Unserved):
        card(t, s, fc.form_elicitation(7, "jira", "Ticket", properties))


def test_more_than_four_questions_or_an_unknown_method_is_unserved(tr):
    store, s, t = tr
    many = fc.user_input(8, "u3", [fc.question(f"q{i}", f"Q{i}", "?") for i in range(5)])
    with pytest.raises(Unserved):
        card(t, s, many)
    with pytest.raises(Unserved):
        t.card("item/tool/call", {}, session=s, run_id="turn_1", node_id="9")


@pytest.mark.parametrize("params", [
    # A device verification wants a proof in its reply, which no answer on a card makes.
    {"mode": "openai/userVerification", "title": "Verify", "description": "Confirm it's you", "challenge": "c1"},
    # OpenAI's own forms have a schema the pinned protocol leaves open, so a card can't type their reply.
    {"mode": "openai/form", "message": "Pick", "requestedSchema": {"anything": True}},
    {"mode": "openaiForm", "message": "Pick", "requestedSchema": {"anything": True}},
], ids=lambda p: p["mode"])
def test_an_elicitation_in_a_mode_a_card_cannot_answer_is_unserved(tr, params):
    store, s, t = tr
    params = {"serverName": "gh", "threadId": "thr_1", "turnId": None, **params}
    with pytest.raises(Unserved, match=f"in mode {params['mode']}"):
        t.card("mcpServer/elicitation/request", params, session=s, run_id="codex-1", node_id="10")


# --- the pinned schema -------------------------------------------------------------------

def test_every_server_request_in_the_pinned_schema_is_served_or_refused():
    schema = json.loads((FIXTURES / "schema" / "ServerRequest.json").read_text())
    methods = {m for branch in schema["oneOf"] for m in branch["properties"]["method"]["enum"]}
    assert methods == SERVED | REFUSED, (
        f"new: {sorted(methods - SERVED - REFUSED)}; gone: {sorted((SERVED | REFUSED) - methods)}")


def test_every_reply_a_card_makes_matches_codexs_response_schema(tr):
    store, s, t = tr
    feed(t, [fc.command_started("c1", "touch a"), fc.file_change("f1", "a.md", "a\n")[0]])
    steps = [fc.command_approval(1, "c1", "touch a"), fc.file_change_approval(2, "f1"),
             fc.permissions_approval(3, "p1"),
             fc.user_input(4, "u1", [fc.question("env", "Env", "Where?", options=["prod", "dev"])]),
             fc.mcp_approval(5, "docs", "search"), fc.mcp_approval_question(6, "u2", "docs", "search"),
             fc.network_approval(7, "c2", "example.com"), fc.url_elicitation(8, "gh", "Sign in", "https://e.com/l"),
             fc.form_elicitation(9, "jira", "Ticket", {"points": {"type": "integer"}, "urgent": {"type": "boolean"}})]
    answers = {4: [{"Env": "dev"}], 9: [{"points": 3, "urgent": "No"}]}  # a form's answer as check_answer returns it
    for step in steps:
        c = card(t, s, step)
        for answer in answers.get(step["id"], c.question.options):
            reply_validator(step["request"]).validate(c.reply(answer)[0])


# --- the recorded real sessions ----------------------------------------------------------

@pytest.fixture
def recorded(tmp_path):
    """A translator for replaying: its session's cwd is the spike's scratch repo as the recordings name it."""
    store = Store(tmp_path / "store.sqlite")
    s = store.create_session(session(harness="codex", work_item_id=None, cwd="/work/spike/ws"))
    yield store, s, Translator(Transcript(store, s.id, lambda e: None), s.cwd)
    store.close()


def replay(tr, path):
    """Feed one recorded session to the translator as the session would: each message the owner sent (every
    ``turn/start``) as a user message, and Codex's messages; return what the owner would see."""
    store, s, t = tr
    cards = []
    for line in path.read_text().splitlines():
        entry = json.loads(line)
        msg = entry["msg"]
        if entry["dir"] == "out":
            if msg.get("method") == "turn/start":  # a new turn or a steer: the office writes both the same way
                t.transcript.user("".join(i.get("text", "") for i in msg["params"]["input"]), author="owner")
            continue
        if "method" not in msg:
            continue
        if "id" in msg and msg["method"] in SERVED:
            params = msg["params"]
            c = t.card(msg["method"], params, session=s, run_id=params.get("turnId") or "codex-0",
                       node_id=str(msg["id"]))
            cards.append({"kind": c.kind, "title": c.question.title, "question": c.question.question,
                          "options": c.question.options, "pages": [p.header for p in c.question.questions or []]})
        elif msg["method"] == "turn/completed":
            turn = msg["params"]["turn"]
            t.turn_completed(turn["id"], turn["status"], turn.get("error"))
        else:
            t.notification(msg["method"], msg["params"])
    messages = [{"role": m.role, "author": m.author,
                 "parts": [{k: v for k, v in p.model_dump(mode="json").items() if k not in ("id", "call_id")}
                           for p in m.parts]} for m in store.list_messages(s.id)]
    return {"messages": messages, "cards": cards}


@pytest.mark.parametrize("path", RECORDED, ids=lambda p: p.stem)
def test_recorded_sessions_translate_as_their_golden_files(recorded, path):
    got = replay(recorded, path)
    golden = FIXTURES / "golden" / f"{path.stem}.json"
    if os.environ.get("AC_UPDATE_GOLDEN") == "1":
        golden.parent.mkdir(exist_ok=True)
        golden.write_text(json.dumps(got, indent=2, ensure_ascii=False) + "\n")
    assert got == json.loads(golden.read_text())


def test_the_recordings_include_the_core_scenarios():
    assert {"plain", "command-approve", "command-decline", "file-change", "interrupt", "steer", "resume"} <= {
        p.stem for p in RECORDED}


def test_the_recorded_steer_keeps_the_running_command_in_the_message_it_started_in(recorded):
    if not SPIKE["S3"]["detail"]["scenarios"]["steer"]["ok"]:  # the key spike.json records its sessions under
        pytest.skip("the spike's steer scenario failed; rerun it with --scenario steer")
    got = replay(recorded, FIXTURES / "sessions" / "steer.jsonl")
    roles = [m["role"] for m in got["messages"]]
    assert roles[:3] == ["user", "assistant", "user"]  # the steer comes after the message the command started in
    [command] = [p for p in got["messages"][1]["parts"] if p.get("tool") == COMMAND]
    assert command["state"] == "completed"
    assert "assistant" in roles[3:]  # what Codex did after reading the steer follows it

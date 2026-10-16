"""Codex items as transcript parts, and server requests as cards with their replies."""

import json
from pathlib import Path

import pytest

from agent_corp.chat.transcript import Transcript
from agent_corp.harness.translate import Translator
from agent_corp.store import Store
from agent_corp.testing import fake_codex as fc
from tests.store.conftest import session

FIXTURES = Path(__file__).parent / "fixtures" / "codex"


@pytest.fixture
def tr(tmp_path):
    store = Store(tmp_path / "store.sqlite")
    s = store.create_session(session(harness="codex", work_item_id=None, cwd="/w"))  # "/w" is what feed fills {cwd} with
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

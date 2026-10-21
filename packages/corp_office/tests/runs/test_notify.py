"""Node changes go out as run.updated: the first at once, then at most one a second per run, the last always sent."""

import time

from opencorp.runs.notify import RunNotifier, run_updated
from tests.chat.conftest import wait_for


def test_the_first_change_goes_at_once_then_one_trailing_event_per_interval():
    sent = []
    n = RunNotifier(sent.append, every=0.2)
    n.changed("r1", lambda: "e1")
    assert sent == ["e1"]
    n.changed("r1", lambda: "e2")
    n.changed("r1", lambda: "e3")
    assert sent == ["e1"]
    wait_for(lambda: sent == ["e1", "e3"], timeout=2, what="the trailing event")
    time.sleep(0.3)
    assert sent == ["e1", "e3"]
    n.close()


def test_runs_are_throttled_apart_and_none_sends_nothing():
    sent = []
    n = RunNotifier(sent.append, every=10)
    n.changed("r1", lambda: "a")
    n.changed("r2", lambda: "b")
    n.changed("r3", lambda: None)
    assert sent == ["a", "b"]
    n.close()


def test_close_stops_the_thread_and_drops_what_waits():
    sent = []
    n = RunNotifier(sent.append, every=10)
    n.changed("r1", lambda: "a")
    n.changed("r1", lambda: "b")
    n.close()
    assert not n._thread.is_alive() and sent == ["a"]
    n.changed("r9", lambda: "c")
    assert sent == ["a"]


def test_a_failing_build_is_logged_and_the_next_still_goes():
    sent = []
    n = RunNotifier(sent.append, every=0)
    n.changed("r1", lambda: 1 / 0)
    n.changed("r2", lambda: "b")
    assert sent == ["b"]
    n.close()


def test_a_run_updated_event_is_an_event_with_a_run_updated_payload():
    e = run_updated("01JA1H00000000000000000001", "01JA1H000000000000000000S1", None, "running", ["chat#1/reply"])
    assert (e.type, e.subject_id, e.data["current_nodes"], e.data["parent_run_id"]) == (
        "run.updated", "01JA1H00000000000000000001", ["chat#1/reply"], None)

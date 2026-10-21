"""A session's run state, and the status writes that must not race the steps that finish a session."""

import threading
import time

from opencorp.chat.state import SETTLED, guarded_update, not_waiting, run_state, write_state
from tests.store.conftest import session, store  # noqa: F401


def test_a_guarded_update_writes_only_from_the_given_statuses(store):  # noqa: F811
    s = store.create_session(session(status="idle"))
    assert guarded_update(store, s.id, ("idle",), status="busy").status == "busy"
    assert guarded_update(store, s.id, ("idle",), status="ending") is None
    assert store.get_session(s.id).status == "busy"
    assert guarded_update(store, "01K6A0000000000000000000ZZ", ("idle",), status="busy") is None


def test_the_run_state_is_waiting_then_busy_then_idle():
    assert run_state(waiting=True, running=True) == "waiting"
    assert run_state(waiting=False, running=True) == "busy"
    assert run_state(waiting=False, running=False) == "idle"
    assert SETTLED == ("starting", "idle", "busy", "waiting")
    assert not_waiting("ended") == {"status": "ended", "waiting_on": [], "capped": False}


def test_write_state_leaves_ending_debriefing_and_finished_sessions_alone(store):  # noqa: F811
    for left in ("ending", "debriefing", "ended", "failed", "interrupted"):
        s = store.create_session(session(status=left))
        assert write_state(store, s.id, "waiting", ["ngocbh"]) is None
        assert store.get_session(s.id).status == left


def test_starting_lasts_until_the_run_shows_a_turn_or_a_question(store):  # noqa: F811
    s = store.create_session(session(status="starting"))
    assert write_state(store, s.id, "busy", []) is None
    assert write_state(store, s.id, "busy", [], from_starting=("idle", "busy", "waiting")).status == "busy"
    t = store.create_session(session(status="starting"))
    assert write_state(store, t.id, "waiting", ["ngocbh"]).waiting_on == ["ngocbh"]


def test_waiting_on_names_each_person_once_and_only_while_waiting(store):  # noqa: F811
    s = store.create_session(session(status="idle"))
    got = write_state(store, s.id, "waiting", ["ann", None, "ann", "lead"], capped=True)
    assert (got.waiting_on, got.capped) == (["ann", "lead"], True)
    got = write_state(store, s.id, "busy", ["ann"], capped=True)
    assert (got.waiting_on, got.capped) == ([], False)


def test_write_state_waits_for_a_finish_in_flight_and_then_leaves_it(store):  # noqa: F811
    s = store.create_session(session(status="idle"))
    inside, release, got = threading.Event(), threading.Event(), []

    def finish():
        with store.transaction():
            store.update_session(s.id, **not_waiting("failed"))
            inside.set()
            release.wait(5)

    a = threading.Thread(target=finish)
    a.start()
    assert inside.wait(5)
    b = threading.Thread(target=lambda: got.append(write_state(store, s.id, "waiting", ["ngocbh"])))
    b.start()
    time.sleep(0.1)
    assert b.is_alive()  # it waits for the finish to commit
    release.set()
    a.join(5), b.join(5)
    assert got == [None] and store.get_session(s.id).status == "failed"

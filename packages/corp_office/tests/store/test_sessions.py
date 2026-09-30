"""Sessions, their runs, recent sessions, and worked folders."""

import pytest

from agent_corp.store import DuplicateKey, NotFound, StoreError
from tests.store.conftest import debrief, feedback, message, proposal, question, session

NO_SESSION = "01K6A0000000000000000000ZZ"


def test_session_round_trips_with_runs(store):
    s = session(run_ids=["run-1", "run-2"], seed="ctx", cost_cap_usd=2.5, kind="side", question_id=None)
    got = store.create_session(s)
    assert got == s == store.get_session(s.id)
    assert store.events_after()[-1].type == "session.created"


def test_add_session_run_appends_and_emits(store):
    s = store.create_session(session())
    store.add_session_run(s.id, "run-1")
    got = store.add_session_run(s.id, "run-2")
    assert got.run_ids == ["run-1", "run-2"]
    assert store.session_for_run("run-2").id == s.id and store.session_for_run("nope") is None
    event = store.events_after()[-1]
    assert event.type == "session.updated" and event.data["run_ids"] == ["run-1", "run-2"]


def test_a_run_belongs_to_one_session(store):
    a, b = store.create_session(session()), store.create_session(session())
    store.add_session_run(a.id, "run-1")
    with pytest.raises(DuplicateKey):
        store.add_session_run(b.id, "run-1")
    with pytest.raises(NotFound):
        store.add_session_run("01K6A0000000000000000000ZZ", "run-9")


def test_update_session(store):
    s = store.create_session(session())
    got = store.update_session(s.id, status="busy", cost=0.25)
    assert (got.status, got.cost) == ("busy", 0.25) and got.updated_at >= s.updated_at
    with pytest.raises(StoreError):
        store.update_session(s.id, run_ids=["x"])
    assert store.events_after()[-1].data["status"] == "busy"


def test_recent_sessions_per_person(store):
    old = store.create_session(session(updated_at="2026-09-29T10:00:00.000Z"))
    new = store.create_session(session(updated_at="2026-09-29T11:00:00.000Z"))
    store.create_session(session(person="lan"))
    assert [s.id for s in store.recent_sessions("minh")] == [new.id, old.id]
    store.update_session(old.id, status="busy")
    assert [s.id for s in store.recent_sessions("minh")] == [old.id, new.id]
    assert [s.id for s in store.recent_sessions("minh", limit=1)] == [old.id]
    assert [s.id for s in store.list_sessions(status=["busy"])] == [old.id]


def test_worked_folders_order_for_the_picker(store):
    store.touch_worked_folder("minh", "/a", at="2026-09-29T10:00:00.000Z")
    store.touch_worked_folder("minh", "/b", at="2026-09-29T11:00:00.000Z")
    store.touch_worked_folder("minh", "/c", at="2026-09-29T09:00:00.000Z")
    store.touch_worked_folder("lan", "/z")
    assert [f.cwd for f in store.worked_folders("minh")] == ["/b", "/a", "/c"]
    store.touch_worked_folder("minh", "/c", at="2026-09-29T12:00:00.000Z")
    assert [f.cwd for f in store.worked_folders("minh", limit=2)] == ["/c", "/b"]
    assert store.events_after() == []


@pytest.mark.parametrize(
    "write",
    [
        lambda s: s.add_question(question(NO_SESSION)),
        lambda s: s.add_feedback(feedback(NO_SESSION)),
        lambda s: s.add_message(message(NO_SESSION)),
        lambda s: s.save_debrief(debrief(NO_SESSION)),
        lambda s: s.add_profile_proposal(proposal(NO_SESSION)),
        lambda s: s.add_session_run(NO_SESSION, "run-9"),
    ],
    ids=["question", "feedback", "message", "debrief", "proposal", "run"],
)
def test_session_owned_rows_need_their_session(store, write):
    with pytest.raises(NotFound):
        write(store)
    assert store.events_after() == []

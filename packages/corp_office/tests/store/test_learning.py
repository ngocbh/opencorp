"""Debriefs and profile proposals."""

import pytest

from opencorp.store import DuplicateKey, InvalidTransition, StoreError
from tests.store.conftest import COMMIT, debrief, proposal, session


@pytest.fixture
def sid(store):
    return store.create_session(session()).id


def test_debrief_round_trips(store, sid):
    d = debrief(
        sid, state="ready", summary="Fixed it", status="done", artifacts=["a.py"], decisions=["use sqlite"],
        follow_ups=[{"text": "add tests"}, {"text": "docs", "confirmed": True, "work_item_id": None}],
        open_questions=["why?"], cost=0.4,
    )
    assert store.save_debrief(d, run_id="run-1") == d == store.get_debrief(sid)
    record = store.get_debrief_record(sid)
    assert (record.debrief, record.run_id, record.attempts) == (d, "run-1", 0)
    assert store.events_after()[-1].type == "debrief.created"


def test_debrief_update_keeps_bookkeeping(store, sid):
    store.save_debrief(debrief(sid), run_id="run-1", attempts=1)
    ready = debrief(sid, state="ready", summary="ok")
    assert store.save_debrief(ready) == ready
    record = store.get_debrief_record(sid)
    assert (record.run_id, record.attempts) == ("run-1", 1)
    store.save_debrief(ready, attempts=2)
    assert store.get_debrief_record(sid).attempts == 2
    assert store.events_after()[-1].type == "debrief.updated"


def test_pending_debriefs(store, sid):
    other = store.create_session(session()).id
    store.save_debrief(debrief(sid))
    store.save_debrief(debrief(other, state="ready"))
    assert [r.debrief.session_id for r in store.list_debrief_records(state="pending")] == [sid]
    assert store.get_debrief("01K6A0000000000000000000ZZ") is None


def test_proposal_round_trips(store, sid):
    p = proposal(sid)
    assert store.add_profile_proposal(p) == p == store.get_profile_proposal(p.id)
    with pytest.raises(DuplicateKey):
        store.add_profile_proposal(p)
    assert store.events_after()[-1].type == "profile_proposal.created"


def test_proposal_apply_and_terminal_states(store, sid):
    p = store.add_profile_proposal(proposal(sid))
    applied = store.set_profile_proposal_status(p.id, "applied", commit=COMMIT)
    assert (applied.status, applied.commit) == ("applied", COMMIT)
    assert store.events_after()[-1].type == "profile_proposal.updated"
    for status in ("open", "stale", "discarded", "applied"):
        with pytest.raises(InvalidTransition):
            store.set_profile_proposal_status(p.id, status)


def test_proposal_commit_goes_with_applied_only(store, sid):
    p = store.add_profile_proposal(proposal(sid))
    with pytest.raises(StoreError, match="commit"):
        store.set_profile_proposal_status(p.id, "applied")
    with pytest.raises(StoreError, match="commit"):
        store.set_profile_proposal_status(p.id, "discarded", commit=COMMIT)
    assert store.get_profile_proposal(p.id).status == "open"


def test_list_proposals_per_person(store, sid):
    a = store.add_profile_proposal(proposal(sid))
    b = store.add_profile_proposal(proposal(sid))
    store.add_profile_proposal(proposal(sid, person="lan"))
    store.set_profile_proposal_status(b.id, "stale")
    assert [p.id for p in store.list_profile_proposals("minh")] == [a.id, b.id]
    assert [p.id for p in store.list_profile_proposals("minh", status="open")] == [a.id]

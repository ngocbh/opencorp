"""Spend per person since a time."""

from opencorp.protocol.models import PersonCost
from tests.store.conftest import session

T0 = "2026-10-19T00:00:00.000Z"


def test_priced_usage_and_unpriced_harness_sessions_per_person(store):
    minh = store.create_session(session(person="minh"))
    side = store.create_session(session(person="minh", kind="side"))
    store.create_session(session(person="ann", harness="codex"))
    for sid, usd in ((minh.id, 1.0), (side.id, 0.25)):
        store.record_usage(session_id=sid, run_id="r", model="m", input_tokens=1, output_tokens=1, usd=usd)
    report = store.costs_since(T0)
    assert report.since == T0
    assert report.people == {"minh": PersonCost(usd=1.25, unpriced_sessions=0),
                             "ann": PersonCost(usd=0, unpriced_sessions=1)}


def test_usage_and_sessions_before_since_are_left_out(store):
    s = store.create_session(session(person="minh"))
    store.create_session(session(person="ann", harness="claude"))
    store.record_usage(session_id=s.id, run_id="r", model="m", input_tokens=1, output_tokens=1, usd=2.0)
    assert store.costs_since("2999-01-01T00:00:00.000Z").people == {}

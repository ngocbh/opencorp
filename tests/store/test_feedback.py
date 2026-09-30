"""Feedback and its status moves."""

import pytest

from agent_corp.store import InvalidTransition
from tests.store.conftest import COMMIT, feedback, session


@pytest.fixture
def sid(store):
    return store.create_session(session()).id


def test_feedback_round_trips(store, sid):
    f = feedback(sid)
    assert store.add_feedback(f) == f == store.get_feedback(f.id)
    assert store.events_after()[-1].type == "feedback.created"


def test_learning_counts_attempts_then_applies(store, sid):
    f = store.add_feedback(feedback(sid))
    assert store.set_feedback_status(f.id, "learning").attempts == 1
    assert store.set_feedback_status(f.id, "learning").attempts == 2
    store.set_feedback_status(f.id, "queued")
    assert store.set_feedback_status(f.id, "learning").attempts == 3
    done = store.set_feedback_status(f.id, "applied", commit=COMMIT)
    assert (done.status, done.commit, done.attempts) == ("applied", COMMIT, 3)
    assert store.events_after()[-1].type == "feedback.updated"


@pytest.mark.parametrize(
    ("path", "bad"),
    [
        ([], "applied"),
        ([], "queued"),
        (["learning", "applied"], "learning"),
        (["learning", "applied"], "queued"),
        (["learning_failed"], "learning"),
        (["learning", "learning_failed"], "queued"),
    ],
)
def test_bad_moves_raise(store, sid, path, bad):
    f = store.add_feedback(feedback(sid))
    for step in path:
        store.set_feedback_status(f.id, step)
    with pytest.raises(InvalidTransition):
        store.set_feedback_status(f.id, bad)


def test_list_feedback(store, sid):
    a = store.add_feedback(feedback(sid))
    b = store.add_feedback(feedback(sid, run_id="run-2"))
    store.set_feedback_status(b.id, "learning")
    assert [f.id for f in store.list_feedback(session_id=sid, status="queued")] == [a.id]
    assert [f.id for f in store.list_feedback(run_id="run-2")] == [b.id]

"""The runs table: a row per launched run, a write-once outcome, and run.updated in the same transaction."""

import sqlite3

import pytest

from opencorp.store import RunRow, new_id
from opencorp.store.store import RUN_PAGE_SQL
from tests.store.conftest import session, store  # noqa: F401

T = "2026-10-20T10:00:00.000Z"


def launch(s, **over):
    return RunRow(**{"run_id": new_id(), "session_id": s.id, "flow": "chat", "flow_path": "shared/flows/chat.yaml",
                     "driver": "ngocbh", "parent_run_id": None, "launched_at": T, **over})


def test_a_launch_is_stored_and_emits_run_updated(store):  # noqa: F811
    s = store.create_session(session())
    seen = []
    store.add_listener(seen.append)
    row = store.add_run(launch(s))
    assert store.get_run(row.run_id) == row and row.outcome is None
    (event,) = [e for e in seen if e.type == "run.updated"]
    assert (event.subject_id, event.data) == (row.run_id, {
        "run_id": row.run_id, "session_id": s.id, "parent_run_id": None, "status": "running", "current_nodes": []})


def test_a_parent_with_no_row_is_not_kept(store):  # noqa: F811
    s = store.create_session(session())
    parent = store.add_run(launch(s))
    assert store.add_run(launch(s, parent_run_id=parent.run_id)).parent_run_id == parent.run_id
    assert store.add_run(launch(s, parent_run_id=new_id())).parent_run_id is None


def test_an_outcome_is_written_once_and_its_reason_capped(store):  # noqa: F811
    s = store.create_session(session())
    row = store.add_run(launch(s))
    assert store.end_run(row.run_id, "failed", reason="x" * 300, failed_node="chat#0/reply", at=T)
    assert not store.end_run(row.run_id, "finished", at=T)
    got = store.get_run(row.run_id)
    assert (got.outcome, len(got.reason), got.failed_node, got.ended_at) == ("failed", 200, "chat#0/reply", T)


def test_a_second_outcome_or_an_unknown_run_sends_no_event(store):  # noqa: F811
    s = store.create_session(session())
    row = store.add_run(launch(s))
    store.end_run(row.run_id, "finished", at=T)
    seen = []
    store.add_listener(seen.append)
    assert not store.end_run(row.run_id, "failed", at=T)
    assert not store.end_run(new_id(), "finished", at=T)
    assert [e for e in seen if e.type == "run.updated"] == []


def test_an_outcome_outside_the_three_is_refused(store):  # noqa: F811
    s = store.create_session(session())
    row = store.add_run(launch(s))
    with pytest.raises(sqlite3.IntegrityError):
        store.end_run(row.run_id, "running", at=T)
    assert store.get_run(row.run_id).outcome is None


def test_an_outcome_rolls_back_with_its_transaction(store):  # noqa: F811
    s = store.create_session(session(status="busy"))
    row = store.add_run(launch(s))
    with pytest.raises(RuntimeError), store.transaction():
        store.update_session(s.id, status="ended")
        store.end_run(row.run_id, "finished")
        raise RuntimeError("killed between the writes")
    assert store.get_session(s.id).status == "busy" and store.get_run(row.run_id).outcome is None


def test_the_sweep_interrupts_open_rows_but_the_kept_ones_with_no_end_time(store):  # noqa: F811
    s = store.create_session(session())
    kept, swept, done = (store.add_run(launch(s)) for _ in range(3))
    store.end_run(done.run_id, "finished", at=T)
    assert store.sweep_runs({kept.run_id}, reason="the office stopped") == [swept.run_id]
    got = store.get_run(swept.run_id)
    assert (got.outcome, got.reason, got.ended_at) == ("interrupted", "the office stopped", None)
    assert store.get_run(kept.run_id).outcome is None and store.get_run(done.run_id).outcome == "finished"


def test_the_sweep_sends_one_run_updated_per_swept_row(store):  # noqa: F811
    s = store.create_session(session())
    kept, *swept = (store.add_run(launch(s)) for _ in range(3))
    seen = []
    store.add_listener(seen.append)
    store.sweep_runs({kept.run_id}, reason="the office stopped")
    events = [e for e in seen if e.type == "run.updated"]
    assert [(e.subject_id, e.data["status"]) for e in events] == [(r.run_id, "interrupted") for r in swept]


def test_rows_by_session_page_and_parent(store):  # noqa: F811
    s = store.create_session(session())
    top = store.add_run(launch(s))
    kids = [store.add_run(launch(s, parent_run_id=top.run_id)) for _ in range(2)]
    assert [r.run_id for r in store.runs_of_session(s.id)] == [top.run_id, *[k.run_id for k in kids]]
    assert [r.run_id for r in store.run_page(before=None, limit=10)] == [top.run_id]
    assert [r.run_id for r in store.run_children([top.run_id])] == [kids[1].run_id, kids[0].run_id]
    assert store.get_runs([top.run_id, "nope"]) == {top.run_id: top}
    assert [r.run_id for r in store.run_page(before=top.run_id, limit=10)] == []


@pytest.mark.parametrize("before", [None, "01K0000000000000000000000Z"])
def test_a_page_seeks_the_parent_index_and_sorts_nothing(store, before):  # noqa: F811
    plan = [r["detail"] for r in store._conn().execute(f"EXPLAIN QUERY PLAN {RUN_PAGE_SQL}", (before, 50))]
    assert any("USING INDEX runs_parent" in d for d in plan), plan
    assert not any("TEMP B-TREE" in d for d in plan), plan


def test_a_runs_usage_is_summed_from_its_model_calls(store):  # noqa: F811
    s = store.create_session(session())
    for n in (1, 2):
        store.record_usage(session_id=s.id, run_id="run-a", model="m", input_tokens=10 * n, output_tokens=n, usd=0.5)
    assert store.run_usage("run-a") == (30, 3, 1.0) and store.run_usage("run-b") == (0, 0, 0.0)

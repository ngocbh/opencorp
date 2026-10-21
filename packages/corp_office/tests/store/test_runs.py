"""The runs table: a row per launched run, a write-once outcome, and run.updated in the same transaction."""

import sqlite3
import threading

import pytest

from opencorp.store import RunRow, new_id
from opencorp.store.store import CHILD_COUNTS_SQL, RUN_PAGE_SQL, run_page_query
from tests.store.conftest import question, session, store  # noqa: F401

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
    assert store.end_run(row.run_id, "failed", reason="x" * 3000, failed_node="chat#0/reply", at=T)
    assert not store.end_run(row.run_id, "finished", at=T)
    got = store.get_run(row.run_id)
    assert (got.outcome, len(got.reason), got.failed_node, got.ended_at) == ("failed", 256, "chat#0/reply", T)
    assert got.reason.endswith("…")
    # Kept a little past what's shown.
    other = store.add_run(launch(s))
    store.end_run(other.run_id, "failed", reason="x" * 256)
    assert store.get_run(other.run_id).reason == "x" * 256


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


def test_a_page_of_one_parents_children_newest_first_from_a_cursor(store):  # noqa: F811
    s = store.create_session(session())
    top = store.add_run(launch(s))
    kids = [store.add_run(launch(s, parent_run_id=top.run_id)).run_id for _ in range(3)]
    assert [r.run_id for r in store.run_page(parent=top.run_id, before=None, limit=2)] == kids[:0:-1]
    assert [r.run_id for r in store.run_page(parent=top.run_id, before=kids[1], limit=2)] == [kids[0]]
    assert store.run_page(parent=new_id(), before=None, limit=2) == []


def test_a_launch_range_is_since_inclusive_and_until_exclusive(store):  # noqa: F811
    s = store.create_session(session())
    at = [f"2026-10-{d:02}T10:00:00.000Z" for d in (10, 11, 12, 13)]
    ids = [store.add_run(launch(s, launched_at=t)).run_id for t in at]
    page = store.run_page(before=None, limit=10, since=at[1], until=at[3])
    assert [r.run_id for r in page] == [ids[2], ids[1]]
    assert [r.run_id for r in store.run_page(before=None, limit=10, since=at[2])] == [ids[3], ids[2]]
    assert [r.run_id for r in store.run_page(before=None, limit=10, until=at[1])] == [ids[0]]
    assert [r.run_id for r in store.run_page(before=ids[2], limit=10, since=at[1])] == [ids[1]]
    kid = store.add_run(launch(s, parent_run_id=ids[0], launched_at=at[3])).run_id
    assert [r.run_id for r in store.run_page(parent=ids[0], before=None, limit=10, since=at[3])] == [kid]
    assert store.run_page(parent=ids[0], before=None, limit=10, until=at[3]) == []
    # A top-level run launched before the range is on the page when a run it started was launched in it.
    assert [r.run_id for r in store.run_page(before=None, limit=10, since=at[2])] == [ids[3], ids[2], ids[0]]
    assert [r.run_id for r in store.run_page(before=ids[2], limit=10, since=at[2])] == [ids[0]]
    assert [r.run_id for r in store.run_page(before=None, limit=10, since=at[2], until=at[3])] == [ids[2]]


def _old_runs(store, s, n, parent=None):  # noqa: F811
    """``n`` runs launched a month before T (under ``parent``, if given), written in one transaction."""
    with store.transaction() as tx:
        for _ in range(n):
            tx.execute("INSERT INTO runs (run_id, session_id, flow, flow_path, driver, parent_run_id, launched_at) "
                       "VALUES (?, ?, 'chat', 'shared/flows/chat.yaml', 'ngocbh', ?, '2026-09-20T10:00:00.000Z')",
                       (new_id(), s.id, parent))


def _steps(store, **query):  # noqa: F811
    """``run_page(**query)`` and how many SQLite VM steps it took: they grow with every row the query visits."""
    conn, count = store._conn(), [0]

    def tick():
        count[0] += 1

    conn.set_progress_handler(tick, 1)
    try:
        rows = store.run_page(**query)
    finally:
        conn.set_progress_handler(None, 1)
    return rows, count[0]


@pytest.mark.parametrize("child", [False, True])
def test_a_seven_day_query_over_many_old_runs_visits_only_the_rows_in_range(store, child):  # noqa: F811
    s = store.create_session(session())
    old_at = "2026-09-01T10:00:00.000Z"
    top = store.add_run(launch(s, launched_at=old_at)).run_id if child else None
    # Top-level: an old run with a recent child is on the page too.
    old_parent = None if child else store.add_run(launch(s, launched_at=old_at)).run_id
    recent = [store.add_run(launch(s, parent_run_id=top)).run_id for _ in range(3)]
    if old_parent:
        store.add_run(launch(s, parent_run_id=old_parent))
    expected = recent[::-1] + ([old_parent] if old_parent else [])
    query = {"before": None, "limit": 50, "since": "2026-10-13T10:00:00.000Z", "parent": top}
    rows, few = _steps(store, **query)
    assert [r.run_id for r in rows] == expected
    # Ids newer than the recent runs': a run_id walk would meet them first. Old children of the old parent too.
    _old_runs(store, s, 3_000, parent=top)
    _old_runs(store, s, 3_000, parent=top or old_parent)
    rows, many = _steps(store, **query)
    assert [r.run_id for r in rows] == expected
    assert many - few < 100, (few, many)  # 6,000 more rows out of range, and the query visits none of them


@pytest.mark.parametrize("parent", [None, "01K0000000000000000000000Z"])
def test_a_launch_range_reads_the_launch_indexes(store, parent):  # noqa: F811
    sql, params = run_page_query(parent=parent, before=None, limit=50, since=T, until=T)
    plan = [r["detail"] for r in store._conn().execute(f"EXPLAIN QUERY PLAN {sql}", params)]
    assert any("USING INDEX runs_launched" in d or "USING COVERING INDEX runs_launched" in d for d in plan), plan
    if parent is None:  # and the parents of children launched in range
        assert any("INDEX runs_child_launched" in d for d in plan), plan


def test_children_are_counted_and_their_drivers_listed_by_parent(store):  # noqa: F811
    s = store.create_session(session())
    a, b = store.add_run(launch(s)).run_id, store.add_run(launch(s)).run_id
    store.add_run(launch(s, parent_run_id=a, flow="side_chat", driver="lan"))
    store.add_run(launch(s, parent_run_id=a, flow="debrief", driver="office"))
    store.add_run(launch(s, parent_run_id=a, flow="side_chat", driver="kai"))
    assert store.run_child_counts([a, b, "nope"]) == {a: 3} and store.run_child_counts([]) == {}
    assert store.child_drivers([a, b], "side_chat") == {a: ["kai", "lan"]}
    sql = CHILD_COUNTS_SQL.format("?, ?")
    plan = [r["detail"] for r in store._conn().execute(f"EXPLAIN QUERY PLAN {sql}", (a, b))]
    assert any(d.startswith("SEARCH runs USING COVERING INDEX") for d in plan), plan  # an index alone, no rows


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


def test_a_snapshot_doesnt_see_writes_from_another_connection(store):  # noqa: F811
    s = store.create_session(session())
    run_id = store.add_run(launch(s)).run_id
    with store.snapshot():
        assert store.get_run(run_id).outcome is None
        other = threading.Thread(target=lambda: store.end_run(run_id, "finished"))
        other.start()
        other.join()
        assert store.get_run(run_id).outcome is None
    assert store.get_run(run_id).outcome == "finished"


def test_children_by_launch_range_and_open_only(store):  # noqa: F811
    s = store.create_session(session())
    top = store.add_run(launch(s)).run_id
    early = store.add_run(launch(s, parent_run_id=top, launched_at="2026-10-10T10:00:00.000Z")).run_id
    done = store.add_run(launch(s, parent_run_id=top)).run_id
    store.end_run(done, "finished")
    open_ = store.add_run(launch(s, parent_run_id=top)).run_id
    assert [r.run_id for r in store.run_children([top])] == [open_, done, early]
    assert [r.run_id for r in store.run_children([top], since="2026-10-13T00:00:00.000Z")] == [open_, done]
    assert [r.run_id for r in store.run_children([top], until="2026-10-13T00:00:00.000Z")] == [early]
    assert [r.run_id for r in store.run_children([top], since="2026-10-13T00:00:00.000Z", open_only=True)] == [open_]


def test_long_id_lists_are_read_in_chunks(store, monkeypatch):  # noqa: F811
    from opencorp.store import store as store_module

    monkeypatch.setattr(store_module, "IN_CHUNK", 2)
    s = store.create_session(session())
    tops = [store.add_run(launch(s)).run_id for _ in range(5)]
    kids = [store.add_run(launch(s, parent_run_id=t, flow="side_chat", driver="lan")).run_id for t in tops]
    for t, k in zip(tops, kids, strict=True):
        store.add_question(question(s.id, run_id=k, source="human_input", node_id=f"chat#{t[-3:]}/ask"))
    assert set(store.get_runs(tops)) == set(tops)
    assert store.run_child_counts(tops) == dict.fromkeys(tops, 1)
    assert store.child_drivers(tops, "side_chat") == {t: ["lan"] for t in tops}
    assert [r.run_id for r in store.run_children(tops)] == kids[::-1]
    assert [q.run_id for q in store.list_questions(run_id=kids)] == kids


OLD = "2026-09-01T10:00:00.000Z"
RECENT = "2026-10-13T10:00:00.000Z"


def test_open_or_recent_is_every_open_run_and_every_run_launched_since(store):  # noqa: F811
    s = store.create_session(session())

    def closed(**over):
        run_id = store.add_run(launch(s, **over)).run_id
        store.end_run(run_id, "finished")
        return run_id

    old_open = store.add_run(launch(s, launched_at=OLD)).run_id
    old_closed = closed(launched_at=OLD)
    open_kid_parent = closed(launched_at=OLD)
    store.add_run(launch(s, parent_run_id=open_kid_parent, launched_at=OLD))
    recent_kid_parent = closed(launched_at=OLD)
    recent_kid = closed(parent_run_id=recent_kid_parent)
    old_kid = closed(parent_run_id=recent_kid_parent, launched_at=OLD)
    recent = closed()
    page = [r.run_id for r in store.run_page(before=None, limit=10, recent=RECENT)]
    assert page == [recent, recent_kid_parent, open_kid_parent, old_open] and old_closed not in page
    assert [r.run_id for r in store.run_page(before=open_kid_parent, limit=10, recent=RECENT)] == [old_open]
    assert [r.run_id for r in store.run_page(parent=recent_kid_parent, before=None, limit=10, recent=RECENT)] \
        == [recent_kid]
    assert [r.run_id for r in store.run_children([recent_kid_parent, open_kid_parent], recent=RECENT)] \
        == [recent_kid, *[r.run_id for r in store.run_children([open_kid_parent])]]
    assert old_kid not in [r.run_id for r in store.run_children([recent_kid_parent], recent=RECENT)]
    with pytest.raises(ValueError):
        store.run_page(before=None, limit=10, recent=RECENT, since=RECENT)


@pytest.mark.parametrize("child", [False, True])
def test_the_default_open_or_recent_query_stays_flat_as_old_closed_runs_are_added(store, child):  # noqa: F811
    s = store.create_session(session())
    top = store.add_run(launch(s, launched_at=OLD)).run_id if child else None
    old_open = store.add_run(launch(s, parent_run_id=top, launched_at=OLD)).run_id
    recent = store.add_run(launch(s, parent_run_id=top)).run_id
    store.end_run(recent, "finished")
    query = {"before": None, "limit": 50, "recent": RECENT, "parent": top}
    rows, few = _steps(store, **query)
    assert [r.run_id for r in rows] == [recent, old_open]
    with store.transaction() as tx:  # old closed runs, and old closed children of an old open run
        for parent in [top] * 3_000 + [top or old_open] * 3_000:
            tx.execute("INSERT INTO runs (run_id, session_id, flow, flow_path, driver, parent_run_id, launched_at, "
                       "outcome, ended_at) VALUES (?, ?, 'chat', 'x', 'ngocbh', ?, ?, 'finished', ?)",
                       (new_id(), s.id, parent, OLD, OLD))
    rows, many = _steps(store, **query)
    assert [r.run_id for r in rows] == [recent, old_open]
    assert many - few < 100, (few, many)  # 6,000 more old closed rows, and the query visits none of them


@pytest.mark.parametrize("parent", [None, "01K0000000000000000000000Z"])
def test_open_or_recent_reads_the_open_index(store, parent):  # noqa: F811
    sql, params = run_page_query(parent=parent, before=None, limit=50, recent=T)
    plan = [r["detail"] for r in store._conn().execute(f"EXPLAIN QUERY PLAN {sql}", params)]
    assert any("INDEX runs_open" in d for d in plan) and any("INDEX runs_launched" in d for d in plan), plan
    assert not any(d.startswith("SCAN runs") for d in plan), plan

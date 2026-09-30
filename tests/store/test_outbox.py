"""Transactions, the outbox, and listeners."""

import asyncio
import sqlite3
import threading

import pytest

from agent_corp.protocol.models import Event
from agent_corp.store import NotFound, StoreError, Tx
from tests.store.conftest import work_item


def test_write_and_event_commit_together(store):
    item = store.create_work_item(work_item())
    [event] = store.events_after()
    assert (event.type, event.subject_id, event.data) == ("work_item.created", item.id, item.model_dump(mode="json"))
    Event.model_validate(event.model_dump(mode="json"))


def test_failure_between_write_and_event_lands_neither(store, monkeypatch):
    def boom(self, *args, **kwargs):
        raise RuntimeError("injected")

    monkeypatch.setattr(Tx, "emit", boom)
    item = work_item()
    with pytest.raises(RuntimeError, match="injected"):
        store.create_work_item(item)
    assert store.get_work_item(item.id) is None
    assert store.events_after() == []


def test_failure_in_outer_transaction_undoes_every_write(store):
    a, b = work_item(), work_item()
    with pytest.raises(RuntimeError), store.transaction():
        store.create_work_item(a)
        store.create_work_item(b)
        raise RuntimeError
    assert store.get_work_item(a.id) is None and store.get_work_item(b.id) is None
    assert store.events_after() == []


def test_caught_nested_failure_undoes_only_itself(store):
    a, b = work_item(), work_item()
    with store.transaction():
        store.create_work_item(a)
        with pytest.raises(RuntimeError), store.transaction():
            store.create_work_item(b)
            raise RuntimeError
    assert store.get_work_item(a.id) is not None and store.get_work_item(b.id) is None
    assert [e.subject_id for e in store.events_after()] == [a.id]


def test_own_queries_and_events_share_the_transaction(store):
    item = store.create_work_item(work_item())
    with store.transaction() as tx:
        tx.execute("UPDATE work_items SET summary = ? WHERE id = ?", ("hello", item.id))
        tx.emit("work_item.updated", item.id, store.get_work_item(item.id))
    [_, event] = store.events_after()
    assert event.data["summary"] == "hello"


def test_listeners_run_after_commit_in_order(store):
    got = []

    def listener(event):
        # The change is visible to other connections by the time the listener runs.
        seen = []
        t = threading.Thread(target=lambda: seen.append(store.get_work_item(event.subject_id)))
        t.start()
        t.join()
        got.append((event.type, seen[0] is not None))

    store.add_listener(listener)
    item = store.create_work_item(work_item())
    store.update_work_item(item.id, status="done")
    assert got == [("work_item.created", True), ("work_item.updated", True)]


def test_rolled_back_events_are_not_delivered(store):
    got = []
    store.add_listener(got.append)
    with pytest.raises(RuntimeError), store.transaction():
        store.create_work_item(work_item())
        raise RuntimeError
    assert got == []


def test_failing_listener_is_logged_not_raised(store, caplog):
    store.add_listener(lambda e: 1 / 0)
    got = []
    store.add_listener(got.append)
    store.create_work_item(work_item())
    assert len(got) == 1 and "store listener failed" in caplog.text


def test_remove_listener(store):
    got = []
    remove = store.add_listener(got.append)
    remove()
    store.create_work_item(work_item())
    assert got == []


def test_events_after_and_limit(store):
    ids = [store.create_work_item(work_item()).id for _ in range(3)]
    events = store.events_after()
    assert [e.subject_id for e in events] == ids
    assert [e.subject_id for e in store.events_after(events[0].id)] == ids[1:]
    assert [e.subject_id for e in store.events_after(limit=2)] == ids[:2]
    with pytest.raises(NotFound):
        store.events_after("01K6A0000000000000000000ZZ")


def test_unsent_and_mark_sent(store):
    for _ in range(3):
        store.create_work_item(work_item())
    first, *rest = store.unsent_events()
    store.mark_sent([first.id])
    store.mark_sent([first.id])
    assert store.unsent_events() == rest


def test_emit_alone_writes_one_event(store):
    event = store.emit("profile.updated", "minh", {"person": "minh"})
    assert store.events_after() == [event]


def test_bad_event_type_rolls_back(store):
    item = work_item()
    with pytest.raises(ValueError), store.transaction() as tx:
        store.create_work_item(item)
        tx.emit("no.such.type", item.id, {})
    assert store.get_work_item(item.id) is None


def test_concurrent_writers_serialize(store):
    items = [work_item() for _ in range(20)]
    threads = [threading.Thread(target=store.create_work_item, args=(i,)) for i in items]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(store.list_work_items()) == 20 and len(store.events_after()) == 20


def test_listener_writes_are_delivered_in_commit_order(store):
    seen_by_b = []

    def a(event):
        if event.type == "work_item.created":
            store.update_work_item(event.subject_id, status="in_progress")

    store.add_listener(a)
    store.add_listener(lambda event: seen_by_b.append(event.id))
    store.create_work_item(work_item())
    assert seen_by_b == [e.id for e in store.events_after()]
    assert [e.type for e in store.events_after()] == ["work_item.created", "work_item.updated"]


def test_another_task_cannot_join_an_open_transaction(store):
    a, b = work_item(), work_item()
    errors = []

    async def holder():
        with store.transaction():
            store.create_work_item(a)
            await asyncio.sleep(0.05)

    async def intruder():
        await asyncio.sleep(0.01)
        for write in (lambda: store.create_work_item(b), store.transaction().__enter__):
            try:
                write()
            except StoreError as exc:
                errors.append(str(exc))

    async def main():
        await asyncio.gather(holder(), intruder())

    asyncio.run(main())
    assert len(errors) == 2 and all("another task" in e for e in errors)
    assert store.get_work_item(a.id) is not None and store.get_work_item(b.id) is None
    assert [e.subject_id for e in store.events_after()] == [a.id]


def test_one_task_nests_transactions(store):
    item = work_item()

    async def main():
        with store.transaction():
            store.create_work_item(item)

    asyncio.run(main())
    assert store.get_work_item(item.id) is not None


def _fail_whole_transaction_on(store, cwd):
    # RAISE(ROLLBACK) makes SQLite end the whole transaction, as SQLITE_FULL or an I/O error can.
    store._conn().execute(
        "CREATE TEMP TRIGGER boom BEFORE INSERT ON worked_folders "
        f"WHEN NEW.cwd = '{cwd}' BEGIN SELECT RAISE(ROLLBACK, 'disk full'); END"
    )


def test_savepoint_keeps_the_error_when_sqlite_ended_the_transaction(store):
    _fail_whole_transaction_on(store, "/boom")
    item = work_item()
    with pytest.raises(sqlite3.IntegrityError, match="disk full"), store.transaction():
        store.create_work_item(item)
        with store.transaction():
            store.touch_worked_folder("minh", "/boom")
    assert store.get_work_item(item.id) is None and store.events_after() == []
    store.touch_worked_folder("minh", "/ok")
    assert [f.cwd for f in store.worked_folders("minh")] == ["/ok"]


def test_no_writes_after_sqlite_ended_the_transaction(store):
    _fail_whole_transaction_on(store, "/boom")
    later = work_item()
    with pytest.raises(StoreError, match="rolled back"), store.transaction() as tx:
        with pytest.raises(sqlite3.IntegrityError):
            store.touch_worked_folder("minh", "/boom")
        try:
            store.create_work_item(later)
        finally:
            with pytest.raises(StoreError, match="rolled back"):
                tx.execute("UPDATE work_items SET summary = 'x'")
    assert store.get_work_item(later.id) is None and store.events_after() == []

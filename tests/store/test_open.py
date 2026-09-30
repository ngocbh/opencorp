"""Opening the store: schema, WAL, per-thread connections."""

import gc
import sqlite3
import threading

import pytest

from agent_corp.store import MigrationError, Store
from agent_corp.store.migrate import MIGRATIONS, ladder
from agent_corp.store.store import enable_wal

TABLES = {
    "work_items", "comments", "sessions", "session_runs", "questions", "feedback", "messages", "parts",
    "outbox", "worked_folders", "audit", "usage", "workers", "debriefs", "profile_proposals",
}


def test_open_creates_every_table(store):
    names = {r[0] for r in store._conn().execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert TABLES <= names


def test_open_migrates_to_the_latest_file(store):
    assert store._conn().execute("PRAGMA user_version").fetchone()[0] == ladder(MIGRATIONS)[-1][0]


def test_wal_and_busy_timeout(store):
    conn = store._conn()
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    assert conn.execute("PRAGMA busy_timeout").fetchone()[0] >= 5000
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1


def test_one_connection_per_thread(store):
    seen = []
    t = threading.Thread(target=lambda: seen.append(store._conn()))
    t.start()
    t.join()
    assert store._conn() is store._conn()
    assert seen[0] is not store._conn()


def test_finished_threads_release_their_connections(tmp_path):
    s = Store(tmp_path / "s.sqlite")
    started, done = threading.Event(), threading.Event()

    def hold():
        s._conn()
        started.set()
        done.wait(10)

    held = threading.Thread(target=hold, daemon=True)
    held.start()
    started.wait(10)
    try:
        for _ in range(20):
            t = threading.Thread(target=s.list_workers)
            t.start()
            t.join()
        gc.collect()
        # This thread's connection and the live thread's; the finished threads' are gone.
        assert len(s._conns) == 2
        s.close()
        assert len(s._conns) == 0
    finally:
        done.set()
        held.join()


def test_reopen_keeps_data_and_version(tmp_path):
    path = tmp_path / "s.sqlite"
    with Store(path) as s:
        s._conn().execute("INSERT INTO worked_folders VALUES ('minh', '/w', '2026-09-29T10:00:00.000Z')")
    with Store(path) as s:
        assert [r[0] for r in s._conn().execute("SELECT cwd FROM worked_folders")] == ["/w"]


def test_newer_store_is_refused(tmp_path):
    path = tmp_path / "s.sqlite"
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA user_version = 9999")
    conn.close()
    with pytest.raises(MigrationError, match="newer"):
        Store(path)


class _FakeConn:
    """Answers PRAGMA journal_mode; fails the first ``busy`` calls with SQLITE_BUSY."""

    def __init__(self, mode, busy=0):
        self.mode, self.busy, self.sql = mode, busy, []

    def execute(self, sql):
        self.sql.append(sql)
        if self.busy:
            self.busy -= 1
            err = sqlite3.OperationalError("database is locked")
            err.sqlite_errorcode = sqlite3.SQLITE_BUSY
            raise err
        if sql == "PRAGMA journal_mode = WAL":
            self.mode = "wal"
        return self

    def fetchone(self):
        return (self.mode,)


def test_wal_is_left_alone_when_already_on():
    conn = _FakeConn("wal")
    enable_wal(conn)
    assert conn.sql == ["PRAGMA journal_mode"]


def test_wal_switch_retries_while_busy():
    conn = _FakeConn("delete", busy=3)
    enable_wal(conn)
    assert conn.mode == "wal"


def test_wal_switch_gives_up_after_the_timeout():
    with pytest.raises(sqlite3.OperationalError, match="locked"):
        enable_wal(_FakeConn("delete", busy=10**6), timeout=0.05)

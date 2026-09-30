"""Opening the store: schema, WAL, per-thread connections."""

import sqlite3
import threading

import pytest

from agent_corp.store import MigrationError, Store
from agent_corp.store.migrate import MIGRATIONS, ladder

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

"""The office's SQLite store."""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

from ulid import ULID

from agent_corp.store.migrate import migrate

BUSY_TIMEOUT_S = 10.0


def new_id() -> str:
    """Return a new ULID string."""
    return str(ULID())


class Store:
    """The office store at ``path``: WAL mode, one connection per thread, migrated on open."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self._conns: list[sqlite3.Connection] = []
        self._conns_lock = threading.Lock()
        conn = self._conn()
        conn.execute("PRAGMA journal_mode = WAL")
        migrate(conn)

    def __enter__(self) -> Store:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        """Close every thread's connection."""
        with self._conns_lock:
            for conn in self._conns:
                conn.close()
            self._conns.clear()
        self._local = threading.local()

    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            # check_same_thread=False only so close() can close every thread's connection;
            # each connection is still used by its own thread alone.
            conn = sqlite3.connect(self.path, timeout=BUSY_TIMEOUT_S, isolation_level=None, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA synchronous = NORMAL")
            self._local.conn = conn
            with self._conns_lock:
                self._conns.append(conn)
        return conn

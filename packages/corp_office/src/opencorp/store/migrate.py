"""Numbered SQL migrations, applied in order above ``PRAGMA user_version``."""

import re
import sqlite3
from collections.abc import Iterator
from importlib.resources import files
from importlib.resources.abc import Traversable

MIGRATIONS = files("opencorp.store") / "migrations"
_NAME = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")


class MigrationError(Exception):
    """A migration file is misnamed or incomplete, or the database is newer than the code."""


def user_version(conn: sqlite3.Connection) -> int:
    """Return the database's ``PRAGMA user_version``: the last migration applied."""
    return conn.execute("PRAGMA user_version").fetchone()[0]


def ladder(directory: Traversable) -> list[tuple[int, Traversable]]:
    """Return the ``NNNN_<name>.sql`` files in ``directory`` as ``(number, file)``, in order."""
    found: dict[int, Traversable] = {}
    for entry in directory.iterdir():
        if not entry.name.endswith(".sql"):
            continue
        match = _NAME.match(entry.name)
        if match is None or int(match[1]) == 0:
            raise MigrationError(f"bad migration file name: {entry.name}")
        number = int(match[1])
        if number in found:
            raise MigrationError(f"two migrations numbered {number:04d}: {found[number].name}, {entry.name}")
        found[number] = entry
    return sorted(found.items())


def statements(sql: str) -> Iterator[str]:
    """Split a SQL script into single statements (trigger bodies and quoted ``;`` stay whole)."""
    buf = ""
    for char in sql:
        buf += char
        if char == ";" and sqlite3.complete_statement(buf):
            yield buf.strip()
            buf = ""
    if any(line.strip() and not line.strip().startswith("--") for line in buf.splitlines()):
        raise MigrationError(f"incomplete statement at end of migration: {buf.strip()[:80]!r}")


def migrate(conn: sqlite3.Connection, directory: Traversable = MIGRATIONS) -> int:
    """Apply each migration numbered above ``user_version``, in order, one transaction each.

    ``conn`` must be in autocommit mode (``isolation_level=None``). Gaps in the numbering are
    allowed. Returns the new ``user_version``.
    """
    files_ = ladder(directory)
    latest = files_[-1][0] if files_ else 0
    current = user_version(conn)
    if current > latest:
        raise MigrationError(f"store is at version {current}, newer than this code ({latest})")
    for number, entry in files_:
        if number <= current:
            continue
        conn.execute("BEGIN IMMEDIATE")
        try:
            # Another process may have applied it while this one waited for the write lock.
            if user_version(conn) >= number:
                conn.execute("ROLLBACK")
                continue
            for statement in statements(entry.read_text()):
                conn.execute(statement)
            conn.execute(f"PRAGMA user_version = {number}")
            conn.execute("COMMIT")
        except BaseException:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
    return user_version(conn)

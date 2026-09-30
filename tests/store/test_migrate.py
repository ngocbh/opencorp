"""The migration ladder applies numbered SQL files above PRAGMA user_version."""

import sqlite3

import pytest

from agent_corp.store.migrate import MigrationError, migrate, statements, user_version


def _conn(tmp_path):
    return sqlite3.connect(tmp_path / "db.sqlite", isolation_level=None)


def _write(directory, files):
    directory.mkdir(exist_ok=True)
    for name, sql in files.items():
        (directory / name).write_text(sql)
    return directory


def _tables(conn):
    return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}


def test_fresh_db_gets_every_file(tmp_path):
    ladder = _write(tmp_path / "m", {"0001_a.sql": "CREATE TABLE a (x);", "0002_b.sql": "CREATE TABLE b (x);"})
    conn = _conn(tmp_path)
    assert migrate(conn, ladder) == 2
    assert _tables(conn) == {"a", "b"} and user_version(conn) == 2


def test_db_at_one_gets_only_newer_files(tmp_path):
    conn = _conn(tmp_path)
    migrate(conn, _write(tmp_path / "m", {"0001_a.sql": "CREATE TABLE a (x);"}))
    # Re-running 0001 would fail: table a already exists.
    migrate(conn, _write(tmp_path / "m", {"0002_b.sql": "CREATE TABLE b (x);"}))
    assert _tables(conn) == {"a", "b"} and user_version(conn) == 2


def test_gap_applies_in_order(tmp_path):
    ladder = _write(
        tmp_path / "m",
        {"0003_c.sql": "INSERT INTO a VALUES (3);", "0001_a.sql": "CREATE TABLE a (x);\nINSERT INTO a VALUES (1);"},
    )
    conn = _conn(tmp_path)
    assert migrate(conn, ladder) == 3
    assert [r[0] for r in conn.execute("SELECT x FROM a ORDER BY rowid")] == [1, 3]


def test_failed_file_rolls_back_and_keeps_version(tmp_path):
    ladder = _write(
        tmp_path / "m",
        {"0001_a.sql": "CREATE TABLE a (x);", "0002_bad.sql": "CREATE TABLE b (x);\nNOT SQL;"},
    )
    conn = _conn(tmp_path)
    with pytest.raises(sqlite3.OperationalError):
        migrate(conn, ladder)
    assert _tables(conn) == {"a"} and user_version(conn) == 1


def test_db_newer_than_code_is_refused(tmp_path):
    conn = _conn(tmp_path)
    conn.execute("PRAGMA user_version = 7")
    with pytest.raises(MigrationError, match="newer"):
        migrate(conn, _write(tmp_path / "m", {"0001_a.sql": "CREATE TABLE a (x);"}))


@pytest.mark.parametrize("names", [["1_a.sql"], ["0001_A.sql"], ["0000_zero.sql"], ["0001_a.sql", "0001_b.sql"]])
def test_bad_names_are_refused(tmp_path, names):
    ladder = _write(tmp_path / "m", dict.fromkeys(names, "SELECT 1;"))
    with pytest.raises(MigrationError):
        migrate(_conn(tmp_path), ladder)


def test_statements_split_on_complete_statements():
    sql = """
    -- a comment; with a semicolon
    CREATE TABLE a (x TEXT DEFAULT 'a;b');
    CREATE TRIGGER t AFTER INSERT ON a BEGIN
        UPDATE a SET x = 'y'; DELETE FROM a WHERE x = 'z';
    END;
    -- trailing comment
    """
    parts = list(statements(sql))
    assert len(parts) == 2
    assert parts[0].endswith("DEFAULT 'a;b');") and parts[1].startswith("CREATE TRIGGER")


def test_incomplete_statement_is_refused():
    with pytest.raises(MigrationError, match="incomplete"):
        list(statements("CREATE TABLE a (x)"))

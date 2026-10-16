"""The office's SQLite store: protocol entities, office bookkeeping, and the event outbox.

Entities go in and come out as the generated protocol models. Every write that changes
metadata inserts its ``Event`` into ``outbox`` in the same transaction; listeners see the
events after the commit. Messages and parts are live content and emit no events.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import threading
import time
import weakref
from collections import deque
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import BaseModel
from ulid import ULID

from agent_corp.protocol import now
from agent_corp.protocol.models import (
    Comment,
    Debrief,
    ErrorPart,
    Event,
    Feedback,
    FilePart,
    Message,
    ProfileProposal,
    Question,
    Session,
    TextPart,
    ToolPart,
    WorkItem,
)
from agent_corp.store.migrate import migrate

log = logging.getLogger(__name__)

type Part = TextPart | FilePart | ToolPart | ErrorPart
type Listener = Callable[[Event], None]

BUSY_TIMEOUT_S = 10.0


class _Connection(sqlite3.Connection):
    """A ``sqlite3.Connection`` that can be weakly referenced (the C type can't).

    ``close`` waits for a statement running on another thread instead of closing under it.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        # sqlite3 drops the GIL while a statement runs, then reads the connection's handle,
        # which close() from another thread has already cleared: the interpreter crashes.
        self._use = threading.Lock()

    def execute(self, sql: str, params: Any = (), /) -> sqlite3.Cursor:
        with self._use:
            return super().execute(sql, params)

    def close(self) -> None:
        with self._use:
            super().close()


def enable_wal(conn: sqlite3.Connection, *, timeout: float = BUSY_TIMEOUT_S) -> None:
    """Put the database in WAL mode, unless it already is.

    Switching needs an exclusive lock. When several processes open a new database at
    once, SQLite can report it busy without calling the busy handler, so retry with
    backoff for up to ``timeout`` seconds.
    """
    deadline = time.monotonic() + timeout
    delay = 0.005
    while True:
        try:
            if conn.execute("PRAGMA journal_mode").fetchone()[0] != "wal":
                conn.execute("PRAGMA journal_mode = WAL")
            return
        except sqlite3.OperationalError as exc:
            # The low byte is the primary result code (SQLITE_BUSY_RECOVERY is a BUSY too).
            busy = (getattr(exc, "sqlite_errorcode", 0) & 0xFF) in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED)
            if not busy or time.monotonic() + delay > deadline:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 0.25)


def new_id() -> str:
    """Return a new ULID string."""
    return str(ULID())


class StoreError(Exception):
    """A store operation was refused."""


class NotFound(StoreError, LookupError):
    """The row to change does not exist."""


class DuplicateKey(StoreError):
    """A row with the same key already exists."""


class InvalidTransition(StoreError, ValueError):
    """A status change the entity's state machine does not allow."""


class StaleVersion(StoreError):
    """A work item update was based on an older version."""

    def __init__(self, expected: int, current: int) -> None:
        super().__init__(f"based on version {expected}, current is {current}")
        self.expected = expected
        self.current = current


@dataclass(frozen=True)
class DebriefRecord:
    """A stored debrief with the bookkeeping columns the protocol model doesn't carry."""

    debrief: Debrief
    run_id: str | None
    attempts: int


@dataclass(frozen=True)
class WorkedFolder:
    """A folder a person has had a session in, for the picker."""

    cwd: str
    last_at: str


@dataclass(frozen=True)
class AuditEntry:
    """One tool call as recorded by the permission layer."""

    id: int
    at: str
    person: str
    kind: str
    tool: str
    args: dict[str, Any]
    outcome: str
    session_id: str | None
    run_id: str | None
    detail: str | None


@dataclass(frozen=True)
class UsageRecord:
    """Token usage and price of one model call."""

    id: int
    at: str
    session_id: str
    run_id: str
    model: str
    input_tokens: int
    output_tokens: int
    usd: float


@dataclass(frozen=True)
class WorkerRecord:
    """A spawned worker process, for the reaper."""

    session_id: str
    pid: int
    pgid: int
    start_time: float


@dataclass(frozen=True)
class _Table:
    name: str
    model: type[BaseModel]
    key: str = "id"
    json: frozenset[str] = frozenset()
    # Model fields kept in a child table rather than a column.
    derived: frozenset[str] = frozenset()


WORK_ITEMS = _Table("work_items", WorkItem, json=frozenset({"groups"}))
COMMENTS = _Table("comments", Comment)
SESSIONS = _Table("sessions", Session, json=frozenset({"harness_usage"}), derived=frozenset({"run_ids"}))
QUESTIONS = _Table(
    "questions", Question, json=frozenset({"options", "questions", "answer_schema", "discussion", "answer"})
)
FEEDBACK = _Table("feedback", Feedback)
MESSAGES = _Table("messages", Message, derived=frozenset({"parts"}))
DEBRIEFS = _Table(
    "debriefs", Debrief, key="session_id", json=frozenset({"artifacts", "decisions", "follow_ups", "open_questions"})
)
PROPOSALS = _Table("profile_proposals", ProfileProposal)

_ANSWERED = frozenset({"answered", "consumed"})
_QUESTION_MOVES = {"open": {"answered", "stale"}, "answered": {"consumed"}}
_FEEDBACK_MOVES = {
    "queued": {"learning", "learning_failed"},
    "learning": {"learning", "queued", "applied", "learning_failed"},
}
_PROPOSAL_MOVES = {"open": {"applied", "discarded", "stale"}}


def _model[M: BaseModel](table: _Table, row: sqlite3.Row, model: type[M], **extra: Any) -> M:
    """Build ``model`` from ``row``. A NULL column with a model default is left unset."""
    fields = model.model_fields
    data: dict[str, Any] = {}
    for name in row.keys():
        if name not in fields:
            continue
        value = row[name]
        if value is None:
            if fields[name].is_required():
                data[name] = None
            continue
        data[name] = json.loads(value) if name in table.json else value
    return model.model_validate({**data, **extra})


def _quote(names: Iterable[str]) -> list[str]:
    return [f'"{n}"' for n in names]


def _current_task() -> asyncio.Task[Any] | None:
    """The asyncio task running on this thread, or ``None`` outside an event loop."""
    try:
        return asyncio.current_task()
    except RuntimeError:
        return None


def _check_move(kind: str, moves: dict[str, set[str]], old: str, new: str) -> None:
    if new not in moves.get(old, set()):
        raise InvalidTransition(f"{kind} cannot move from {old} to {new}")


def _check_commit(kind: str, status: str, commit: str | None) -> None:
    """A move to ``applied`` records the company-repo commit; no other move takes one."""
    if (status == "applied") != (commit is not None):
        need = "needs a commit" if status == "applied" else "takes no commit"
        raise StoreError(f"{kind} moving to {status} {need}")


class Tx:
    """One write transaction on the calling thread's connection, owned by one asyncio task (or none)."""

    def __init__(self, conn: sqlite3.Connection, task: asyncio.Task[Any] | None = None) -> None:
        self.conn = conn
        self.task = task
        self.events: list[Event] = []
        self.depth = 0

    def check_open(self) -> None:
        """Raise ``StoreError`` if SQLite has already rolled this transaction back.

        Some errors (a full disk, an I/O error) end the whole transaction. Without this
        check, later statements would run and commit one by one in autocommit mode.
        """
        if not self.conn.in_transaction:
            raise StoreError("SQLite rolled back this transaction after an error; start a new one")

    def execute(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        """Run one statement in this transaction."""
        self.check_open()
        return self.conn.execute(sql, tuple(params))

    def emit(self, type: str, subject_id: str, data: BaseModel | dict[str, Any]) -> Event:
        """Insert an ``Event`` into the outbox; listeners get it once the transaction commits."""
        payload = data.model_dump(mode="json") if isinstance(data, BaseModel) else data
        event = Event(id=new_id(), type=type, at=now(), subject_id=subject_id, data=payload)
        self.execute(
            "INSERT INTO outbox (id, type, subject_id, payload, created_at) VALUES (?, ?, ?, ?, ?)",
            (event.id, event.type, event.subject_id, json.dumps(event.data), event.at),
        )
        self.events.append(event)
        return event

    def insert(self, table: _Table, cols: dict[str, Any]) -> None:
        names = list(cols)
        sql = f"INSERT INTO {table.name} ({', '.join(_quote(names))}) VALUES ({', '.join('?' * len(names))})"
        try:
            self.execute(sql, cols.values())
        except sqlite3.IntegrityError as exc:
            if "UNIQUE" in str(exc):
                raise DuplicateKey(f"{table.name}: {exc}") from exc
            if "FOREIGN KEY" in str(exc):
                raise NotFound(f"{table.name}: the row it belongs to does not exist") from exc
            raise StoreError(f"{table.name}: {exc}") from exc

    def update(self, table: _Table, cols: dict[str, Any]) -> None:
        names = [n for n in cols if n != table.key]
        sets = ", ".join(f"{q} = ?" for q in _quote(names))
        self.execute(
            f'UPDATE {table.name} SET {sets} WHERE "{table.key}" = ?',
            (*(cols[n] for n in names), cols[table.key]),
        )


class Store:
    """The office store at ``path``: WAL mode, one connection per thread, migrated on open.

    Writes take ``BEGIN IMMEDIATE`` and are also serialized in-process, so listeners see
    events in commit order. Never ``await`` inside a transaction.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        # Weak, so a finished thread's connection is closed once collected (its statement
        # cache refers back to it, so that takes the cyclic GC, not just the thread ending).
        self._conns: weakref.WeakSet[sqlite3.Connection] = weakref.WeakSet()
        self._conns_lock = threading.Lock()
        self._closed = False
        self._write_lock = threading.RLock()
        self._listeners: list[Listener] = []
        self._table_columns: dict[str, frozenset[str]] = {}
        conn = self._conn()
        enable_wal(conn)
        migrate(conn)

    def __enter__(self) -> Store:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        """Close every thread's connection, each once its running statement ends.

        From then on, store calls on any thread raise ``sqlite3.ProgrammingError``, as does
        a transaction that another thread still has open.
        """
        with self._conns_lock:
            self._closed = True
            conns = list(self._conns)
            self._conns.clear()
        for conn in conns:
            conn.close()
        self._local = threading.local()

    # --- connections and transactions -------------------------------------------------

    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            if self._closed:
                raise sqlite3.ProgrammingError("the store is closed")
            # check_same_thread=False only so close() can close every thread's connection;
            # each connection is still used by its own thread alone.
            conn = sqlite3.connect(
                self.path, timeout=BUSY_TIMEOUT_S, isolation_level=None, check_same_thread=False,
                factory=_Connection,
            )
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA synchronous = NORMAL")
            with self._conns_lock:
                closed = self._closed
                if not closed:
                    self._conns.add(conn)
            if closed:  # close() ran while this connection opened
                conn.close()
                raise sqlite3.ProgrammingError("the store is closed")
            self._local.conn = conn
        return conn

    @contextmanager
    def transaction(self) -> Iterator[Tx]:
        """A write transaction (``BEGIN IMMEDIATE``) on this thread's connection.

        Store methods called inside it join it. A nested ``transaction()`` is a savepoint:
        if it raises, only its own writes and events are undone. Events are delivered to
        listeners after the outermost commit.

        A transaction belongs to the asyncio task that opened it: another task on the same
        thread that enters ``transaction()`` (or calls a store method that writes) while it
        is open raises ``StoreError`` instead of silently joining it.
        """
        tx: Tx | None = getattr(self._local, "tx", None)
        if tx is not None:
            if tx.task is not _current_task():
                raise StoreError(
                    "another task's store transaction is open on this thread; "
                    "never await inside transaction()"
                )
            yield from self._savepoint(tx)
            return
        with self._write_lock:
            conn = self._conn()
            conn.execute("BEGIN IMMEDIATE")
            tx = self._local.tx = Tx(conn, _current_task())
            try:
                yield tx
                tx.check_open()
                conn.execute("COMMIT")
            except BaseException:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                raise
            finally:
                self._local.tx = None
            self._deliver(tx.events)

    def _savepoint(self, tx: Tx) -> Iterator[Tx]:
        tx.check_open()
        tx.depth += 1
        name = f"sp{tx.depth}"
        mark = len(tx.events)
        tx.conn.execute(f"SAVEPOINT {name}")
        try:
            yield tx
        except BaseException:
            # If the error made SQLite end the whole transaction, the savepoint is gone:
            # keep the original error rather than raising "no such savepoint".
            if tx.conn.in_transaction:
                tx.conn.execute(f"ROLLBACK TO {name}")
                tx.conn.execute(f"RELEASE {name}")
            del tx.events[mark:]
            raise
        else:
            tx.conn.execute(f"RELEASE {name}")
        finally:
            tx.depth -= 1

    @contextmanager
    def _read(self) -> Iterator[sqlite3.Connection]:
        """A consistent snapshot for reads that span several statements."""
        conn = self._conn()
        if conn.in_transaction:
            yield conn
            return
        conn.execute("BEGIN")
        try:
            yield conn
        finally:
            conn.execute("COMMIT")

    # --- outbox -------------------------------------------------------------------------

    def add_listener(self, listener: Listener) -> Callable[[], None]:
        """Call ``listener(event)`` for each event after its transaction commits.

        Listeners run on the committing thread while in-process writes are held, so they
        see commit order; they must not block. A listener may write to the store on its own
        thread: those events are delivered, in order, once the current ones are done. A
        listener that raises is logged. Returns a function that removes the listener.
        """
        self._listeners.append(listener)
        removed = False

        def remove() -> None:
            nonlocal removed
            if not removed:
                removed = True
                self._listeners.remove(listener)

        return remove

    def _deliver(self, events: list[Event]) -> None:
        pending: deque[Event] | None = getattr(self._local, "pending", None)
        if pending is not None:
            # A listener wrote to the store: its events go after the ones still being
            # delivered, so every listener sees commit order.
            pending.extend(events)
            return
        pending = self._local.pending = deque(events)
        try:
            while pending:
                event = pending.popleft()
                for listener in list(self._listeners):
                    self._call(listener, event)
        finally:
            self._local.pending = None

    @staticmethod
    def _call(listener: Listener, event: Event) -> None:
        try:
            listener(event)
        except Exception:
            log.exception("store listener failed on %s %s", event.type, event.id)

    def subscribe(self, after_event_id: str | None, listener: Listener) -> Callable[[], None]:
        """Replay the events after ``after_event_id`` (all when ``None``) to ``listener``, then add it.

        Replay and registration happen while holding the in-process write lock, so the
        listener gets each event committed so far, and each one this process commits
        later, exactly once and in commit order. Resume from an event id, not by comparing
        ids: an id is a ULID made when the event is emitted, and two writers can commit in
        the other order, so ULID order is not commit order. Events other processes commit
        show up in a replay but are never delivered live. Raises ``NotFound`` for an
        unknown id. Returns a function that removes the listener.
        """
        if getattr(self._local, "tx", None) is not None or getattr(self._local, "pending", None) is not None:
            # Replay would include events that are then delivered again once committed.
            raise StoreError("subscribe outside a transaction and outside a listener")
        with self._write_lock:
            for event in self.events_after(after_event_id):
                self._call(listener, event)
            return self.add_listener(listener)

    def emit(self, type: str, subject_id: str, data: BaseModel | dict[str, Any]) -> Event:
        """Write an event with no other change (for metadata kept outside the store)."""
        with self.transaction() as tx:
            return tx.emit(type, subject_id, data)

    @staticmethod
    def _event(row: sqlite3.Row) -> Event:
        return Event(
            id=row["id"], type=row["type"], at=row["created_at"], subject_id=row["subject_id"], data=json.loads(row["payload"])
        )

    def events_after(self, event_id: str | None = None, *, limit: int | None = None) -> list[Event]:
        """Events in commit order, after ``event_id`` (all of them when ``None``).

        Event ids are ULIDs made at emit time, so their order is not commit order: resume
        from the last id seen rather than comparing ids.
        """
        with self._read() as conn:
            after = 0
            if event_id is not None:
                row = conn.execute("SELECT seq FROM outbox WHERE id = ?", (event_id,)).fetchone()
                if row is None:
                    raise NotFound(f"no event {event_id}")
                after = row[0]
            rows = conn.execute(
                "SELECT * FROM outbox WHERE seq > ? ORDER BY seq LIMIT ?", (after, -1 if limit is None else limit)
            ).fetchall()
        return [self._event(r) for r in rows]

    def unsent_events(self, *, limit: int | None = None) -> list[Event]:
        """Events not yet marked sent, in commit order."""
        rows = self._conn().execute(
            "SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY seq LIMIT ?", (-1 if limit is None else limit,)
        ).fetchall()
        return [self._event(r) for r in rows]

    def mark_sent(self, event_ids: Iterable[str]) -> None:
        """Mark events as relayed. Marking one twice keeps its first ``sent_at``."""
        at = now()
        with self.transaction() as tx:
            for event_id in event_ids:
                tx.execute("UPDATE outbox SET sent_at = ? WHERE id = ? AND sent_at IS NULL", (at, event_id))

    # --- generic row access -------------------------------------------------------------

    def _columns(self, table: _Table, model: BaseModel) -> dict[str, Any]:
        """The row for ``model``: its full JSON dump, with list and object fields as JSON text.

        A model field with no column (a protocol field added without a store migration)
        raises ``StoreError``.
        """
        cols = model.model_dump(mode="json", exclude=set(table.derived))
        known = self._table_columns.get(table.name)
        if known is None:
            rows = self._conn().execute(f"PRAGMA table_info({table.name})").fetchall()
            known = self._table_columns[table.name] = frozenset(r["name"] for r in rows)
        missing = sorted(cols.keys() - known)
        if missing:
            raise StoreError(
                f"{table.name} has no column {', '.join(map(repr, missing))} for {type(model).__name__}; "
                "the field needs a store migration"
            )
        for name in table.json:
            if cols[name] is not None:
                cols[name] = json.dumps(cols[name])
        return cols

    def _row(self, table: _Table, key: str) -> sqlite3.Row | None:
        return self._conn().execute(f'SELECT * FROM {table.name} WHERE "{table.key}" = ?', (key,)).fetchone()

    def _get[M: BaseModel](self, table: _Table, model: type[M], key: str) -> M | None:
        row = self._row(table, key)
        return None if row is None else _model(table, row, model)

    def _must[M: BaseModel](self, table: _Table, model: type[M], key: str) -> M:
        found = self._get(table, model, key)
        if found is None:
            raise NotFound(f"no {table.name} row {key}")
        return found

    def _list[M: BaseModel](
        self, table: _Table, model: type[M], where: dict[str, Any], order: str, limit: int | None = None
    ) -> list[M]:
        clauses, params = [], []
        for name, value in where.items():
            if value is None:
                continue
            if isinstance(value, (tuple, list, set, frozenset)):
                clauses.append(f'"{name}" IN ({", ".join("?" * len(value))})')
                params.extend(value)
            else:
                clauses.append(f'"{name}" = ?')
                params.append(value)
        sql = f"SELECT * FROM {table.name}"
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += f" ORDER BY {order} LIMIT ?"
        rows = self._conn().execute(sql, (*params, -1 if limit is None else limit)).fetchall()
        return [_model(table, r, model) for r in rows]

    @staticmethod
    def _changed[M: BaseModel](current: M, changes: dict[str, Any], frozen: set[str]) -> M:
        bad = frozen & changes.keys()
        if bad:
            raise StoreError(f"cannot change {sorted(bad)} this way")
        return type(current).model_validate({**current.model_dump(mode="json"), **changes})

    # --- work items and comments --------------------------------------------------------

    def create_work_item(self, item: WorkItem) -> WorkItem:
        """Insert a work item and emit ``work_item.created``."""
        with self.transaction() as tx:
            tx.insert(WORK_ITEMS, self._columns(WORK_ITEMS, item))
            stored = self._must(WORK_ITEMS, WorkItem, item.id)
            tx.emit("work_item.created", item.id, stored)
        return stored

    def get_work_item(self, item_id: str) -> WorkItem | None:
        """The work item, or ``None``."""
        return self._get(WORK_ITEMS, WorkItem, item_id)

    def list_work_items(
        self, *, assignee: str | None = None, status: str | Iterable[str] | None = None, limit: int | None = None
    ) -> list[WorkItem]:
        """Work items, newest first, optionally filtered."""
        status = status if status is None or isinstance(status, str) else tuple(status)
        return self._list(
            WORK_ITEMS, WorkItem, {"assignee": assignee, "status": status}, "created_at DESC, rowid DESC", limit
        )

    def update_work_item(self, item_id: str, *, base_version: int | None = None, **changes: Any) -> WorkItem:
        """Change fields of a work item, bump its version, and emit ``work_item.updated``.

        With ``base_version``, a work item at another version raises ``StaleVersion``.
        """
        with self.transaction() as tx:
            current = self._must(WORK_ITEMS, WorkItem, item_id)
            if base_version is not None and base_version != current.version:
                raise StaleVersion(base_version, current.version)
            changes = {"updated_at": now(), **changes}
            item = self._changed(current, changes, {"id", "version", "created_at"})
            item = item.model_copy(update={"version": current.version + 1})
            tx.update(WORK_ITEMS, self._columns(WORK_ITEMS, item))
            stored = self._must(WORK_ITEMS, WorkItem, item_id)
            tx.emit("work_item.updated", item_id, stored)
        return stored

    def add_comment(self, comment: Comment) -> Comment:
        """Insert a comment and emit ``comment.created``."""
        with self.transaction() as tx:
            tx.insert(COMMENTS, self._columns(COMMENTS, comment))
            stored = self._must(COMMENTS, Comment, comment.id)
            tx.emit("comment.created", comment.id, stored)
        return stored

    def list_comments(self, work_item_id: str) -> list[Comment]:
        """A work item's comments, oldest first."""
        return self._list(COMMENTS, Comment, {"work_item_id": work_item_id}, "created_at, rowid")

    # --- sessions, runs, worked folders -------------------------------------------------

    def _session(self, row: sqlite3.Row) -> Session:
        runs = self._conn().execute(
            "SELECT run_id FROM session_runs WHERE session_id = ? ORDER BY seq", (row["id"],)
        ).fetchall()
        return _model(SESSIONS, row, Session, run_ids=[r[0] for r in runs])

    def _insert_run(self, tx: Tx, session_id: str, run_id: str) -> None:
        try:
            tx.execute(
                "INSERT INTO session_runs (session_id, run_id, seq) "
                "VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM session_runs WHERE session_id = ?))",
                (session_id, run_id, session_id),
            )
        except sqlite3.IntegrityError as exc:
            if "UNIQUE" in str(exc):
                raise DuplicateKey(f"run {run_id} already belongs to a session") from exc
            raise NotFound(f"no session {session_id}") from exc

    def create_session(self, session: Session) -> Session:
        """Insert a session (and its ``run_ids``) and emit ``session.created``."""
        with self.transaction() as tx:
            tx.insert(SESSIONS, self._columns(SESSIONS, session))
            for run_id in session.run_ids:
                self._insert_run(tx, session.id, run_id)
            stored = self._must_session(session.id)
            tx.emit("session.created", session.id, stored)
        return stored

    def get_session(self, session_id: str) -> Session | None:
        """The session with its runs, or ``None``."""
        with self._read():
            row = self._row(SESSIONS, session_id)
            return None if row is None else self._session(row)

    def _must_session(self, session_id: str) -> Session:
        found = self.get_session(session_id)
        if found is None:
            raise NotFound(f"no session {session_id}")
        return found

    def list_sessions(
        self,
        *,
        person: str | None = None,
        status: str | Iterable[str] | None = None,
        kind: str | None = None,
        limit: int | None = None,
    ) -> list[Session]:
        """Sessions, most recently updated first, optionally filtered."""
        status = status if status is None or isinstance(status, str) else tuple(status)
        with self._read() as conn:
            clauses, params = [], []
            for name, value in {"person": person, "status": status, "kind": kind}.items():
                if value is None:
                    continue
                if isinstance(value, tuple):
                    clauses.append(f"{name} IN ({', '.join('?' * len(value))})")
                    params.extend(value)
                else:
                    clauses.append(f"{name} = ?")
                    params.append(value)
            where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
            rows = conn.execute(
                f"SELECT * FROM sessions{where} ORDER BY updated_at DESC, rowid DESC LIMIT ?",
                (*params, -1 if limit is None else limit),
            ).fetchall()
            return [self._session(r) for r in rows]

    def recent_sessions(self, person: str, *, limit: int = 20) -> list[Session]:
        """A person's sessions, most recently updated first."""
        return self.list_sessions(person=person, limit=limit)

    def session_for_run(self, run_id: str) -> Session | None:
        """The session a run belongs to, or ``None``."""
        row = self._conn().execute("SELECT session_id FROM session_runs WHERE run_id = ?", (run_id,)).fetchone()
        return None if row is None else self.get_session(row[0])

    def update_session(self, session_id: str, **changes: Any) -> Session:
        """Change fields of a session and emit ``session.updated`` (``updated_at`` defaults to now)."""
        with self.transaction() as tx:
            current = self._must_session(session_id)
            changes = {"updated_at": now(), **changes}
            session = self._changed(current, changes, {"id", "run_ids", "created_at"})
            tx.update(SESSIONS, self._columns(SESSIONS, session))
            stored = self._must_session(session_id)
            tx.emit("session.updated", session_id, stored)
        return stored

    def add_session_run(self, session_id: str, run_id: str) -> Session:
        """Append a run to a session and emit ``session.updated``."""
        with self.transaction() as tx:
            self._must_session(session_id)
            self._insert_run(tx, session_id, run_id)
            tx.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now(), session_id))
            stored = self._must_session(session_id)
            tx.emit("session.updated", session_id, stored)
        return stored

    def touch_worked_folder(self, person: str, cwd: str, *, at: str | None = None) -> None:
        """Record that ``person`` worked in ``cwd`` at ``at`` (default now)."""
        with self.transaction() as tx:
            tx.execute(
                "INSERT INTO worked_folders (person, cwd, last_at) VALUES (?, ?, ?) "
                "ON CONFLICT (person, cwd) DO UPDATE SET last_at = excluded.last_at",
                (person, cwd, at or now()),
            )

    def worked_folders(self, person: str, *, limit: int = 20) -> list[WorkedFolder]:
        """A person's folders, most recent first."""
        rows = self._conn().execute(
            "SELECT cwd, last_at FROM worked_folders WHERE person = ? ORDER BY last_at DESC, cwd LIMIT ?",
            (person, limit),
        ).fetchall()
        return [WorkedFolder(r["cwd"], r["last_at"]) for r in rows]

    # --- questions ----------------------------------------------------------------------

    def _question_columns(self, question: Question) -> dict[str, Any]:
        cols = self._columns(QUESTIONS, question)
        # SQL NULL means "not answered"; an answered question stores its answer as JSON,
        # which may be the text 'null'. An open or stale question keeps no answer fields.
        if question.status in _ANSWERED:
            cols["answer"] = json.dumps(question.model_dump(mode="json", include={"answer"})["answer"])
        else:
            cols.update(answer=None, answer_kind=None, answered_by=None)
        return cols

    def add_question(self, question: Question) -> Question:
        """Insert a question and emit ``question.created``.

        A second question with the same ``(run_id, node_id)`` raises ``DuplicateKey``;
        questions with a null ``node_id`` never collide.
        """
        with self.transaction() as tx:
            tx.insert(QUESTIONS, self._question_columns(question))
            stored = self._must(QUESTIONS, Question, question.id)
            tx.emit("question.created", question.id, stored)
        return stored

    def get_question(self, question_id: str) -> Question | None:
        """The question, or ``None``. ``answer`` is unset until the question is answered."""
        return self._get(QUESTIONS, Question, question_id)

    def get_question_by_node(self, run_id: str, node_id: str) -> Question | None:
        """The ``human_input`` question stored for a run's node, or ``None``."""
        row = self._conn().execute(
            "SELECT * FROM questions WHERE run_id = ? AND node_id = ?", (run_id, node_id)
        ).fetchone()
        return None if row is None else _model(QUESTIONS, row, Question)

    def list_questions(
        self,
        *,
        session_id: str | None = None,
        run_id: str | None = None,
        status: str | Iterable[str] | None = None,
        source: str | None = None,
    ) -> list[Question]:
        """Questions, oldest first, optionally filtered."""
        status = status if status is None or isinstance(status, str) else tuple(status)
        where = {"session_id": session_id, "run_id": run_id, "status": status, "source": source}
        return self._list(QUESTIONS, Question, where, "created_at, rowid")

    def _write_question(self, tx: Tx, question: Question) -> Question:
        tx.update(QUESTIONS, self._question_columns(question))
        stored = self._must(QUESTIONS, Question, question.id)
        tx.emit("question.updated", question.id, stored)
        return stored

    def answer_question(
        self, question_id: str, answer: Any, answer_kind: str, *, answered_by: str | None = None
    ) -> Question:
        """Answer an open question and emit ``question.updated``.

        The first answer wins: answering a question that is not open raises
        ``InvalidTransition``.
        """
        with self.transaction() as tx:
            current = self._must(QUESTIONS, Question, question_id)
            _check_move("question", _QUESTION_MOVES, current.status, "answered")
            question = self._changed(
                current,
                {
                    "status": "answered",
                    "answer": answer,
                    "answer_kind": answer_kind,
                    "answered_by": answered_by,
                    "updated_at": now(),
                },
                set(),
            )
            return self._write_question(tx, question)

    def set_question_status(self, question_id: str, status: str) -> Question:
        """Move a question to ``consumed`` (from answered) or ``stale`` (from open)."""
        if status == "answered":
            raise InvalidTransition("answer a question with answer_question")
        with self.transaction() as tx:
            current = self._must(QUESTIONS, Question, question_id)
            _check_move("question", _QUESTION_MOVES, current.status, status)
            question = current.model_copy(update={"status": status, "updated_at": now()})
            return self._write_question(tx, question)

    def update_question(self, question_id: str, **changes: Any) -> Question:
        """Change non-status fields (discussion, side_session_id, ...) and emit ``question.updated``."""
        frozen = {"id", "session_id", "run_id", "node_id", "status", "answer", "answer_kind", "answered_by", "created_at"}
        with self.transaction() as tx:
            current = self._must(QUESTIONS, Question, question_id)
            question = self._changed(current, {"updated_at": now(), **changes}, frozen)
            return self._write_question(tx, question)

    # --- feedback -----------------------------------------------------------------------

    def add_feedback(self, feedback: Feedback) -> Feedback:
        """Insert feedback and emit ``feedback.created``."""
        with self.transaction() as tx:
            tx.insert(FEEDBACK, self._columns(FEEDBACK, feedback))
            stored = self._must(FEEDBACK, Feedback, feedback.id)
            tx.emit("feedback.created", feedback.id, stored)
        return stored

    def get_feedback(self, feedback_id: str) -> Feedback | None:
        """The feedback, or ``None``."""
        return self._get(FEEDBACK, Feedback, feedback_id)

    def list_feedback(
        self, *, session_id: str | None = None, run_id: str | None = None, status: str | Iterable[str] | None = None
    ) -> list[Feedback]:
        """Feedback, oldest first, optionally filtered."""
        status = status if status is None or isinstance(status, str) else tuple(status)
        where = {"session_id": session_id, "run_id": run_id, "status": status}
        return self._list(FEEDBACK, Feedback, where, "created_at, rowid")

    def set_feedback_status(self, feedback_id: str, status: str, *, commit: str | None = None,
                            failure: str | None = None) -> Feedback:
        """Move feedback along ``queued → learning → applied | learning_failed``.

        ``learning`` may go back to ``queued`` or start again; each move into ``learning``
        counts one attempt. ``queued`` may fail directly. ``commit`` is required for
        ``applied`` and refused otherwise; ``failure``, why it failed, goes with ``learning_failed`` only.
        Emits ``feedback.updated``.
        """
        with self.transaction() as tx:
            current = self._must(FEEDBACK, Feedback, feedback_id)
            _check_move("feedback", _FEEDBACK_MOVES, current.status, status)
            _check_commit("feedback", status, commit)
            if failure is not None and status != "learning_failed":
                raise StoreError(f"feedback moving to {status} takes no failure")
            update: dict[str, Any] = {"status": status}
            if status == "learning":
                update["attempts"] = current.attempts + 1
            if commit is not None:
                update["commit"] = commit
            if failure is not None:
                update["failure"] = failure
            feedback = self._changed(current, update, set())
            tx.update(FEEDBACK, self._columns(FEEDBACK, feedback))
            stored = self._must(FEEDBACK, Feedback, feedback_id)
            tx.emit("feedback.updated", feedback_id, stored)
        return stored

    # --- messages and parts (live content: no events) -----------------------------------

    def _put_part(self, tx: Tx, message_id: str, part: Part) -> None:
        if not isinstance(part, (TextPart, FilePart, ToolPart, ErrorPart)):
            raise TypeError(f"not a part: {type(part).__name__}")
        cur = tx.execute(
            "INSERT INTO parts (id, message_id, seq, type, data) "
            "VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM parts WHERE message_id = ?), ?, ?) "
            "ON CONFLICT (id) DO UPDATE SET type = excluded.type, data = excluded.data "
            "WHERE parts.message_id = excluded.message_id",
            (part.id, message_id, message_id, part.type, part.model_dump_json()),
        )
        if cur.rowcount == 0:
            raise DuplicateKey(f"part {part.id} belongs to another message")

    def _message(self, row: sqlite3.Row) -> Message:
        parts = self._conn().execute(
            "SELECT data FROM parts WHERE message_id = ? ORDER BY seq", (row["id"],)
        ).fetchall()
        return _model(MESSAGES, row, Message, parts=[json.loads(p[0]) for p in parts])

    def add_message(self, message: Message) -> Message:
        """Insert a message and its parts."""
        with self.transaction() as tx:
            tx.insert(MESSAGES, self._columns(MESSAGES, message))
            for part in message.parts:
                self._put_part(tx, message.id, part)
            return self._must_message(message.id)

    def put_part(self, message_id: str, part: Part) -> Message:
        """Add a part to the end of a message, or replace the part with the same id in place."""
        with self.transaction() as tx:
            self._must_message(message_id)
            self._put_part(tx, message_id, part)
            return self._must_message(message_id)

    def get_message(self, message_id: str) -> Message | None:
        """The message with its parts, or ``None``."""
        with self._read():
            row = self._row(MESSAGES, message_id)
            return None if row is None else self._message(row)

    def _must_message(self, message_id: str) -> Message:
        found = self.get_message(message_id)
        if found is None:
            raise NotFound(f"no message {message_id}")
        return found

    def list_messages(self, session_id: str) -> list[Message]:
        """A session's transcript, oldest first."""
        with self._read() as conn:
            rows = conn.execute(
                "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, rowid", (session_id,)
            ).fetchall()
            return [self._message(r) for r in rows]

    # --- debriefs -----------------------------------------------------------------------

    def _debrief_record(self, row: sqlite3.Row) -> DebriefRecord:
        return DebriefRecord(_model(DEBRIEFS, row, Debrief), row["run_id"], row["attempts"])

    def save_debrief(self, debrief: Debrief, *, run_id: str | None = None, attempts: int | None = None) -> Debrief:
        """Insert or replace a session's debrief; emits ``debrief.created`` or ``debrief.updated``.

        ``run_id`` and ``attempts`` keep their stored values when not given.
        """
        with self.transaction() as tx:
            row = self._row(DEBRIEFS, debrief.session_id)
            cols = self._columns(DEBRIEFS, debrief)
            cols["run_id"] = run_id if run_id is not None or row is None else row["run_id"]
            cols["attempts"] = attempts if attempts is not None else (0 if row is None else row["attempts"])
            if row is None:
                tx.insert(DEBRIEFS, cols)
            else:
                tx.update(DEBRIEFS, cols)
            stored = self._must(DEBRIEFS, Debrief, debrief.session_id)
            tx.emit("debrief.created" if row is None else "debrief.updated", debrief.session_id, stored)
        return stored

    def get_debrief(self, session_id: str) -> Debrief | None:
        """The session's debrief, or ``None``."""
        return self._get(DEBRIEFS, Debrief, session_id)

    def get_debrief_record(self, session_id: str) -> DebriefRecord | None:
        """The session's debrief with its run id and attempt count, or ``None``."""
        row = self._row(DEBRIEFS, session_id)
        return None if row is None else self._debrief_record(row)

    def list_debrief_records(self, *, state: str | None = None) -> list[DebriefRecord]:
        """Debriefs (for example every ``pending`` one), oldest update first."""
        sql, params = "SELECT * FROM debriefs", ()
        if state is not None:
            sql, params = sql + " WHERE state = ?", (state,)
        rows = self._conn().execute(sql + " ORDER BY updated_at, rowid", params).fetchall()
        return [self._debrief_record(r) for r in rows]

    # --- profile proposals --------------------------------------------------------------

    def add_profile_proposal(self, proposal: ProfileProposal) -> ProfileProposal:
        """Insert a proposal and emit ``profile_proposal.created``."""
        with self.transaction() as tx:
            tx.insert(PROPOSALS, self._columns(PROPOSALS, proposal))
            stored = self._must(PROPOSALS, ProfileProposal, proposal.id)
            tx.emit("profile_proposal.created", proposal.id, stored)
        return stored

    def get_profile_proposal(self, proposal_id: str) -> ProfileProposal | None:
        """The proposal, or ``None``."""
        return self._get(PROPOSALS, ProfileProposal, proposal_id)

    def list_profile_proposals(
        self, person: str, *, status: str | Iterable[str] | None = None
    ) -> list[ProfileProposal]:
        """A person's proposals, oldest first."""
        status = status if status is None or isinstance(status, str) else tuple(status)
        return self._list(PROPOSALS, ProfileProposal, {"person": person, "status": status}, "created_at, rowid")

    def set_profile_proposal_status(
        self, proposal_id: str, status: str, *, commit: str | None = None
    ) -> ProfileProposal:
        """Move an open proposal to ``applied``, ``discarded``, or ``stale``; emits ``profile_proposal.updated``.

        ``commit`` is required for ``applied`` and refused otherwise.
        """
        with self.transaction() as tx:
            current = self._must(PROPOSALS, ProfileProposal, proposal_id)
            _check_move("profile proposal", _PROPOSAL_MOVES, current.status, status)
            _check_commit("profile proposal", status, commit)
            update: dict[str, Any] = {"status": status}
            if commit is not None:
                update["commit"] = commit
            proposal = self._changed(current, update, set())
            tx.update(PROPOSALS, self._columns(PROPOSALS, proposal))
            stored = self._must(PROPOSALS, ProfileProposal, proposal_id)
            tx.emit("profile_proposal.updated", proposal_id, stored)
        return stored

    # --- audit, usage, workers (office bookkeeping: no events) --------------------------

    def record_audit(
        self,
        *,
        person: str,
        kind: str,
        tool: str,
        args: dict[str, Any],
        outcome: str,
        session_id: str | None = None,
        run_id: str | None = None,
        detail: str | None = None,
    ) -> AuditEntry:
        """Append an audit row. ``args`` must already be redacted."""
        at = now()
        with self.transaction() as tx:
            cur = tx.execute(
                "INSERT INTO audit (at, person, session_id, run_id, kind, tool, args, outcome, detail) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (at, person, session_id, run_id, kind, tool, json.dumps(args), outcome, detail),
            )
        return AuditEntry(cur.lastrowid, at, person, kind, tool, args, outcome, session_id, run_id, detail)

    def list_audit(self, *, session_id: str | None = None, person: str | None = None) -> list[AuditEntry]:
        """Audit rows in the order they were written, optionally filtered."""
        clauses, params = [], []
        if session_id is not None:
            clauses, params = [*clauses, "session_id = ?"], [*params, session_id]
        if person is not None:
            clauses, params = [*clauses, "person = ?"], [*params, person]
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self._conn().execute(f"SELECT * FROM audit{where} ORDER BY id", params).fetchall()
        return [
            AuditEntry(
                r["id"], r["at"], r["person"], r["kind"], r["tool"], json.loads(r["args"]),
                r["outcome"], r["session_id"], r["run_id"], r["detail"],
            )
            for r in rows
        ]

    def record_usage(
        self, *, session_id: str, run_id: str, model: str, input_tokens: int, output_tokens: int, usd: float
    ) -> UsageRecord:
        """Append the usage of one model call."""
        at = now()
        with self.transaction() as tx:
            cur = tx.execute(
                "INSERT INTO usage (at, session_id, run_id, model, input_tokens, output_tokens, usd) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (at, session_id, run_id, model, input_tokens, output_tokens, usd),
            )
        return UsageRecord(cur.lastrowid, at, session_id, run_id, model, input_tokens, output_tokens, usd)

    def list_usage(self, session_id: str) -> list[UsageRecord]:
        """A session's usage rows in the order they were written."""
        rows = self._conn().execute("SELECT * FROM usage WHERE session_id = ? ORDER BY id", (session_id,)).fetchall()
        return [
            UsageRecord(
                r["id"], r["at"], r["session_id"], r["run_id"], r["model"], r["input_tokens"], r["output_tokens"], r["usd"]
            )
            for r in rows
        ]

    def session_usage_usd(self, session_id: str) -> float:
        """The summed price of a session's model calls."""
        row = self._conn().execute("SELECT COALESCE(SUM(usd), 0) FROM usage WHERE session_id = ?", (session_id,))
        return float(row.fetchone()[0])

    def record_worker(self, session_id: str, *, pid: int, pgid: int, start_time: float) -> WorkerRecord:
        """Record a session's worker, replacing any earlier record for the session."""
        with self.transaction() as tx:
            tx.execute(
                "INSERT INTO workers (session_id, pid, pgid, start_time) VALUES (?, ?, ?, ?) "
                "ON CONFLICT (session_id) DO UPDATE SET pid = excluded.pid, pgid = excluded.pgid, "
                "start_time = excluded.start_time",
                (session_id, pid, pgid, start_time),
            )
        return WorkerRecord(session_id, pid, pgid, start_time)

    def list_workers(self) -> list[WorkerRecord]:
        """Every recorded worker."""
        rows = self._conn().execute("SELECT * FROM workers ORDER BY rowid").fetchall()
        return [WorkerRecord(r["session_id"], r["pid"], r["pgid"], r["start_time"]) for r in rows]

    def remove_worker(self, session_id: str) -> None:
        """Forget a session's worker (a no-op when none is recorded)."""
        with self.transaction() as tx:
            tx.execute("DELETE FROM workers WHERE session_id = ?", (session_id,))

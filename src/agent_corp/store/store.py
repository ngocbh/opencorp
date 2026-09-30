"""The office's SQLite store: protocol entities, office bookkeeping, and the event outbox.

Entities go in and come out as the generated protocol models. Every write that changes
metadata inserts its ``Event`` into ``outbox`` in the same transaction; listeners see the
events after the commit. Messages and parts are live content and emit no events.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
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
    Event,
    Feedback,
    Question,
    Session,
    WorkItem,
)
from agent_corp.store.migrate import migrate

log = logging.getLogger(__name__)

type Listener = Callable[[Event], None]

BUSY_TIMEOUT_S = 10.0


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
class WorkedFolder:
    """A folder a person has had a session in, for the picker."""

    cwd: str
    last_at: str


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
SESSIONS = _Table("sessions", Session, derived=frozenset({"run_ids"}))
QUESTIONS = _Table(
    "questions", Question, json=frozenset({"options", "questions", "answer_schema", "discussion", "answer"})
)
FEEDBACK = _Table("feedback", Feedback)

_ANSWERED = frozenset({"answered", "consumed"})
_QUESTION_MOVES = {"open": {"answered", "stale"}, "answered": {"consumed"}}
_FEEDBACK_MOVES = {
    "queued": {"learning", "learning_failed"},
    "learning": {"learning", "queued", "applied", "learning_failed"},
}


def _columns(table: _Table, model: BaseModel) -> dict[str, Any]:
    """The row for ``model``: its full JSON dump, with list and object fields as JSON text."""
    cols = model.model_dump(mode="json", exclude=set(table.derived))
    for name in table.json:
        if cols[name] is not None:
            cols[name] = json.dumps(cols[name])
    return cols


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


def _check_move(kind: str, moves: dict[str, set[str]], old: str, new: str) -> None:
    if new not in moves.get(old, set()):
        raise InvalidTransition(f"{kind} cannot move from {old} to {new}")


class Tx:
    """One write transaction on the calling thread's connection."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn
        self.events: list[Event] = []
        self.depth = 0

    def execute(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        """Run one statement in this transaction."""
        return self.conn.execute(sql, tuple(params))

    def emit(self, type: str, subject_id: str, data: BaseModel | dict[str, Any]) -> Event:
        """Insert an ``Event`` into the outbox; listeners get it once the transaction commits."""
        payload = data.model_dump(mode="json") if isinstance(data, BaseModel) else data
        event = Event(id=new_id(), type=type, at=now(), subject_id=subject_id, data=payload)
        self.conn.execute(
            "INSERT INTO outbox (id, type, subject_id, payload, created_at) VALUES (?, ?, ?, ?, ?)",
            (event.id, event.type, event.subject_id, json.dumps(event.data), event.at),
        )
        self.events.append(event)
        return event

    def insert(self, table: _Table, cols: dict[str, Any]) -> None:
        names = list(cols)
        sql = f"INSERT INTO {table.name} ({', '.join(_quote(names))}) VALUES ({', '.join('?' * len(names))})"
        try:
            self.conn.execute(sql, tuple(cols.values()))
        except sqlite3.IntegrityError as exc:
            if "UNIQUE" in str(exc):
                raise DuplicateKey(f"{table.name}: {exc}") from exc
            raise StoreError(f"{table.name}: {exc}") from exc

    def update(self, table: _Table, cols: dict[str, Any]) -> None:
        names = [n for n in cols if n != table.key]
        sets = ", ".join(f"{q} = ?" for q in _quote(names))
        self.conn.execute(
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
        self._conns: list[sqlite3.Connection] = []
        self._conns_lock = threading.Lock()
        self._write_lock = threading.RLock()
        self._listeners: list[Listener] = []
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

    # --- connections and transactions -------------------------------------------------

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

    @contextmanager
    def transaction(self) -> Iterator[Tx]:
        """A write transaction (``BEGIN IMMEDIATE``) on this thread's connection.

        Store methods called inside it join it. A nested ``transaction()`` is a savepoint:
        if it raises, only its own writes and events are undone. Events are delivered to
        listeners after the outermost commit.
        """
        tx: Tx | None = getattr(self._local, "tx", None)
        if tx is not None:
            yield from self._savepoint(tx)
            return
        with self._write_lock:
            conn = self._conn()
            conn.execute("BEGIN IMMEDIATE")
            tx = self._local.tx = Tx(conn)
            try:
                yield tx
                conn.execute("COMMIT")
            except BaseException:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                raise
            finally:
                self._local.tx = None
            for event in tx.events:
                self._deliver(event)

    def _savepoint(self, tx: Tx) -> Iterator[Tx]:
        tx.depth += 1
        name = f"sp{tx.depth}"
        mark = len(tx.events)
        tx.conn.execute(f"SAVEPOINT {name}")
        try:
            yield tx
        except BaseException:
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
        see commit order; they must not block. A listener that raises is logged. Returns a
        function that removes the listener.
        """
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener)

    def _deliver(self, event: Event) -> None:
        for listener in list(self._listeners):
            try:
                listener(event)
            except Exception:
                log.exception("store listener failed on %s %s", event.type, event.id)

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
        """Events in commit order, after ``event_id`` (all of them when ``None``)."""
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
            tx.insert(WORK_ITEMS, _columns(WORK_ITEMS, item))
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
            tx.update(WORK_ITEMS, _columns(WORK_ITEMS, item))
            stored = self._must(WORK_ITEMS, WorkItem, item_id)
            tx.emit("work_item.updated", item_id, stored)
        return stored

    def add_comment(self, comment: Comment) -> Comment:
        """Insert a comment and emit ``comment.created``."""
        with self.transaction() as tx:
            tx.insert(COMMENTS, _columns(COMMENTS, comment))
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
            tx.insert(SESSIONS, _columns(SESSIONS, session))
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
            tx.update(SESSIONS, _columns(SESSIONS, session))
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

    @staticmethod
    def _question_columns(question: Question) -> dict[str, Any]:
        cols = _columns(QUESTIONS, question)
        # SQL NULL means "not answered"; an answered question stores its answer as JSON,
        # which may be the text 'null'.
        cols["answer"] = json.dumps(question.answer) if question.status in _ANSWERED else None
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
            tx.insert(FEEDBACK, _columns(FEEDBACK, feedback))
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

    def set_feedback_status(self, feedback_id: str, status: str, *, commit: str | None = None) -> Feedback:
        """Move feedback along ``queued → learning → applied | learning_failed``.

        ``learning`` may go back to ``queued`` or start again; each move into ``learning``
        counts one attempt. ``queued`` may fail directly. Emits ``feedback.updated``.
        """
        with self.transaction() as tx:
            current = self._must(FEEDBACK, Feedback, feedback_id)
            _check_move("feedback", _FEEDBACK_MOVES, current.status, status)
            update: dict[str, Any] = {"status": status}
            if status == "learning":
                update["attempts"] = current.attempts + 1
            if commit is not None:
                update["commit"] = commit
            feedback = self._changed(current, update, set())
            tx.update(FEEDBACK, _columns(FEEDBACK, feedback))
            stored = self._must(FEEDBACK, Feedback, feedback_id)
            tx.emit("feedback.updated", feedback_id, stored)
        return stored

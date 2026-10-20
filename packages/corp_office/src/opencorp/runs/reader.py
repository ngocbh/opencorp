"""Read-only access to Yian run logs that workers may still be appending to: a lazy, bounded index per log, and pages
of node attempts and records. Plain reads only: no lock file, no write, no ``resume_flow``."""

import hashlib
import json
import os
import re
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, BinaryIO

SCHEMAS = frozenset({9})
"""The run-log schemas this office reads: Yian's SCHEMA_VERSION at the submodule pin. The bump to yian#940 adds 10."""
RETIRED = frozenset({7, 8})
"""Schemas Yian retired (yian/runtime/log.py:87); the message says the log is too old."""
OUTCOMES = {"node_succeeded": "succeeded", "node_routed": "routed", "node_expanded": "expanded",
            "node_failed": "failed"}
"""Records that end a node attempt (yian/runtime/state.py, ``_outcome_node_id``), and the status each gives it."""
EVIDENCE = ("evidence", "forward_capture")
"""Payload fields left out of record pages: large, and only shown when one record is opened."""
SPARSE_EVERY = 64
OPEN_CAP = 256
DIVIDER_CAP = 1_000
NODE_CAP = 100_000
CHUNK = 1 << 20
BIG_LINE = 2 << 20
FIELD_CHARS = 4 << 10
PAGE_BYTES = 256 << 10
EVENT_BYTES = 2 << 20
LRU_BYTES = 128 << 20
LRU_LOGS = 128
ERROR_CHARS = 200
# Yian writes sorted-key JSON (log.py:2786-2796), so a record starts with "kind" ("at" first from schema 10): an
# oversized line's kind can be read without parsing it. Its seq is its line number (log.py:2843-2866), so no line's
# seq is ever read from its text.
_HEAD = re.compile(rb'^\{(?:"at":"[^"]{0,64}",)?"kind":"([a-z_]{1,64})"')


class UnreadableLog(Exception):
    """A complete line of the log isn't a run-log record this office can read: the index stops for that log, with a
    message for the run page."""


class UnsupportedSchema(UnreadableLog):
    """A line of the log is in a run-log schema this office can't read."""

    def __init__(self, schema: object) -> None:
        self.schema = schema
        why = "which is older than this office supports" if schema in RETIRED else "which this office can't read"
        super().__init__(f"This log uses run-log schema {schema}, {why}")


class _Rebuild(Exception):
    """The file no longer continues what the index read: read it again from the start."""


@dataclass(slots=True)
class Attempt:
    """One node attempt: its start record's seq, and its outcome once there is one."""

    seq: int
    node_id: str
    end_seq: int | None = None
    status: str = "open"
    handle: str | None = None
    error: str | None = None


@dataclass
class Index:
    """What the office keeps of one log: where it read up to, what the first record says, the open nodes, resume
    dividers, a sparse seq → byte table, and the node table. A refresh folds each line under ``lock``; page reads
    take it too, so they see whole lines only."""

    dev_ino: tuple[int, int]
    offset: int = 0  # after the last complete line read
    last_start: int = 0  # where that line starts, so a rewrite of it is noticed
    last_sha: str = ""
    last_seq: int | None = None
    size: int = 0  # the file's size at the last read
    schemas: set[int] = field(default_factory=set)
    fingerprint: str | None = None
    learnable: bool | None = None
    models: dict[str, str] = field(default_factory=dict)
    open: dict[str, Attempt] = field(default_factory=dict)  # node id -> its latest start, while it has no outcome
    dividers: list[tuple[int, list[str]]] = field(default_factory=list)
    sparse: list[tuple[int, int]] = field(default_factory=list)  # (seq, byte offset), every 64th record
    nodes: list[Attempt] = field(default_factory=list)  # every attempt by start, the newest NODE_CAP
    dropped: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)

    def cost(self) -> int:
        """An estimate of the bytes it holds, for the LRU."""
        return 512 + 160 * len(self.open) + 48 * len(self.sparse) + 96 * len(self.dividers) + 160 * len(self.nodes)


def refresh(path: Path, index: Index | None, *, progress: Callable[[int, int], None] | None = None) -> Index:
    """``index`` brought up to date with ``path`` by reading only what was appended, or a new index read from the start
    when the file was replaced, shrank, rewrote its last line, or its next record isn't the next seq. A torn last line
    is left for the next call. ``progress(done, total)`` is called after each 1 MiB read.

    Raises UnsupportedSchema or UnreadableLog for a complete line this office can't read, or FileNotFoundError.
    """
    st = os.stat(path)
    if index is not None and not _continues(path, index, st):
        index = None
    resumed = index is not None
    if index is None:
        index = Index(dev_ino=(st.st_dev, st.st_ino))
    try:
        with open(path, "rb") as f:
            f.seek(index.offset)
            _read(f, index, st.st_size, resumed, progress)
    except _Rebuild:
        return refresh(path, None, progress=progress)
    index.size = st.st_size
    return index


def _continues(path: Path, index: Index, st: os.stat_result) -> bool:
    """Whether ``path`` still holds what ``index`` read: the same file, no shorter, its last read line unchanged."""
    if (st.st_dev, st.st_ino) != index.dev_ino or st.st_size < index.offset:
        return False
    if index.offset == 0:
        return True
    with open(path, "rb") as f:
        f.seek(index.last_start)
        return hashlib.sha256(f.read(index.offset - index.last_start)).hexdigest() == index.last_sha


def _read(f: BinaryIO, index: Index, total: int, resumed: bool, progress: Callable[[int, int], None] | None) -> None:
    """Fold each complete line from ``f``'s position into ``index``, holding one line at a time. Each line is parsed
    outside ``index.lock`` and folded under it, so a page read never waits on a parse."""
    pos, parts, first = index.offset, [], resumed
    while chunk := f.read(CHUNK):
        start = 0
        while (nl := chunk.find(b"\n", start)) >= 0:
            parts.append(chunk[start:nl + 1])
            line, parts = b"".join(parts), []
            record = _parse(line, pos)
            with index.lock:
                _apply(index, record, line, pos, first)
                index.offset = pos + len(line)
            pos, first, start = pos + len(line), False, nl + 1
        if start < len(chunk):
            parts.append(chunk[start:])
        if progress is not None:
            progress(pos, total)


def _parse(line: bytes, start: int) -> dict[str, Any]:
    try:
        record = json.loads(line)
    except ValueError:
        record = None
    if not isinstance(record, dict):
        raise UnreadableLog(f"This log has a line this office can't read (at byte {start})")
    return record


def _apply(index: Index, record: dict[str, Any], line: bytes, start: int, first: bool) -> None:
    """Fold one parsed line, starting at byte ``start``, into ``index``; ``first`` is the first line past an earlier
    read. Only the envelope and the few payload fields the index keeps are looked at; every check comes before any
    change."""
    schema, seq, kind = record.get("schema"), record.get("seq"), record.get("kind")
    if type(schema) is not int or schema not in SCHEMAS:
        raise UnsupportedSchema(schema)
    expected = 0 if index.last_seq is None else index.last_seq + 1
    if type(seq) is not int or seq != expected:
        if first:
            raise _Rebuild
        raise UnreadableLog(f"This log's records are out of order at line {expected + 1}")
    index.schemas.add(schema)
    index.last_seq, index.last_start, index.last_sha = seq, start, hashlib.sha256(line).hexdigest()
    if seq % SPARSE_EVERY == 0:
        index.sparse.append((seq, start))
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    if kind == "run_started":
        llm = payload.get("effective_llm_by_static_path")
        fingerprint, learnable = payload.get("flow_fingerprint"), payload.get("learnable")
        index.fingerprint = fingerprint if isinstance(fingerprint, str) else None
        index.learnable = learnable if isinstance(learnable, bool) else None
        index.models = {p: str(c["model"]) for p, c in (llm.items() if isinstance(llm, dict) else ())
                        if isinstance(c, dict) and c.get("model")}
    elif kind == "node_started":
        _started(index, seq, payload.get("node_id"))
    elif kind in OUTCOMES:
        _ended(index, seq, kind, payload)
    elif kind == "run_resumed":
        # Recovery retries every start with no outcome (yian docs/api.md, "Durable recovery"): those are restarted.
        for attempt in index.open.values():
            attempt.status = "restarted"
        index.open.clear()
        retried = [n for n in payload.get("retry_node_ids") or [] if isinstance(n, str)][:OPEN_CAP]
        index.dividers.append((seq, retried))
        if len(index.dividers) > DIVIDER_CAP:
            del index.dividers[0]


def _started(index: Index, seq: int, node_id: object) -> None:
    if not isinstance(node_id, str):
        return
    attempt = Attempt(seq, node_id)
    index.open.pop(node_id, None)
    index.open[node_id] = attempt
    if len(index.open) > OPEN_CAP:
        del index.open[next(iter(index.open))]
    index.nodes.append(attempt)
    if len(index.nodes) > NODE_CAP * 11 // 10:  # trimmed in batches: one del per append would be quadratic
        del index.nodes[:len(index.nodes) - NODE_CAP]
        index.dropped = True


def _ended(index: Index, seq: int, kind: str, payload: dict[str, Any]) -> None:
    failure = payload.get("failure") if kind == "node_failed" else payload.get("terminal_failure")
    failure = failure if isinstance(failure, dict) else None
    if kind == "node_expanded":
        node_id = payload.get("spawner_id")
    elif kind == "node_failed":
        node_id = failure.get("node_id") if failure else None
    else:
        node_id = payload.get("node_id")
    attempt = index.open.pop(node_id, None) if isinstance(node_id, str) else None
    if attempt is None:
        return
    attempt.end_seq, attempt.status = seq, OUTCOMES[kind]
    if kind == "node_routed" and isinstance(payload.get("handle"), str):
        attempt.handle = payload["handle"]
    if failure is not None:
        attempt.error = str(failure.get("message") or failure.get("code") or "")[:ERROR_CHARS] or None

"""Read-only access to Yian run logs that workers may still be appending to: a lazy, bounded index per log, and pages
of node attempts and records. Plain reads only: no lock file, no write, no ``resume_flow``."""

import asyncio
import hashlib
import json
import os
import re
import threading
from bisect import bisect_left, bisect_right
from collections import OrderedDict
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, BinaryIO

from opencorp.protocol.models import RunEvent, RunEventPage

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
"""How much of a node's error is shown, cut after the scrub; the index keeps up to FIELD_CHARS of it."""
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
        if type(schema) is not int:  # anything else could be any text, a secret included: never echoed
            super().__init__("This log uses a run-log schema this office can't read")
            return
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
    held: int = 0  # the characters of the node ids, errors and retried ids it keeps
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)

    def cost(self) -> int:
        """An estimate of the bytes it holds, for the LRU."""
        return (512 + 160 * len(self.open) + 48 * len(self.sparse) + 96 * len(self.dividers) + 160 * len(self.nodes)
                + self.held)


def refresh(path: Path, index: Index | None, *, progress: Callable[[int, int], None] | None = None) -> Index:
    """``index`` brought up to date with ``path`` by reading only what was appended, or a new index read from the start
    when the file was replaced, shrank, rewrote its last line, or its next record isn't the next seq. A torn last line
    is left for the next call. ``progress(done, total)`` is called after each 1 MiB read. A line it can't read while
    the file changed under the read is read again once, from the start.

    Raises UnsupportedSchema or UnreadableLog for a complete line this office can't read, or FileNotFoundError.
    """
    st = os.stat(path)
    try:
        return _refresh(path, index, st, progress)
    except UnsupportedSchema:
        raise
    except UnreadableLog:
        now = os.stat(path)
        if (now.st_size, now.st_mtime_ns) == (st.st_size, st.st_mtime_ns):
            raise
        # A writer rewrote the file while it was read (a rollback), so the bad line may be half of each version.
        return _refresh(path, None, now, progress)


def _refresh(path: Path, index: Index | None, st: os.stat_result,
             progress: Callable[[int, int], None] | None) -> Index:
    """``refresh`` against the file as ``st`` found it, without the retry."""
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
        return _refresh(path, None, os.stat(path), progress)
    index.size = max(st.st_size, index.offset)  # it may have grown while it was read
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
            record, sha = _parse(line, pos), hashlib.sha256(line).hexdigest()
            with index.lock:
                _apply(index, record, sha, pos, first)
                index.offset = pos + len(line)
            pos, first, start = pos + len(line), False, nl + 1
        if start < len(chunk):
            parts.append(chunk[start:])
        if progress is not None:
            progress(pos, max(pos, total))


def _parse(line: bytes, start: int) -> dict[str, Any]:
    try:
        record = json.loads(line)
    except ValueError:
        record = None
    if not isinstance(record, dict):
        raise UnreadableLog(f"This log has a line this office can't read (at byte {start})")
    return record


def _apply(index: Index, record: dict[str, Any], sha: str, start: int, first: bool) -> None:
    """Fold one parsed line, starting at byte ``start`` and hashing to ``sha``, into ``index``; ``first`` is the first line past an earlier
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
    index.last_seq, index.last_start, index.last_sha = seq, start, sha
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
        index.held += sum(map(len, retried))
        if len(index.dividers) > DIVIDER_CAP:
            index.held -= sum(map(len, index.dividers.pop(0)[1]))


def _started(index: Index, seq: int, node_id: object) -> None:
    if not isinstance(node_id, str):
        return
    attempt = Attempt(seq, node_id)
    index.open.pop(node_id, None)
    index.open[node_id] = attempt
    if len(index.open) > OPEN_CAP:
        del index.open[next(iter(index.open))]
    index.nodes.append(attempt)
    index.held += len(node_id)
    if len(index.nodes) > NODE_CAP * 11 // 10:  # trimmed in batches: one del per append would be quadratic
        gone = len(index.nodes) - NODE_CAP
        index.held -= sum(len(a.node_id) + len(a.error or "") for a in index.nodes[:gone])
        del index.nodes[:gone]
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
        # Kept long and cut to ERROR_CHARS only once scrubbed, so a known value cut in two can't show its head.
        attempt.error = str(failure.get("message") or failure.get("code") or "")[:FIELD_CHARS] or None
        index.held += len(attempt.error or "")


@dataclass(frozen=True)
class NodePage:
    """Node attempts, newest start first (copies), the dividers among them, and where the next older page starts."""

    nodes: list[Attempt]
    dividers: list[tuple[int, list[str]]]
    next_before: int | None
    dropped: bool


def node_page(index: Index, *, before: int | None, limit: int) -> NodePage:
    """Up to ``limit`` attempts that started before seq ``before`` (all when None), newest first."""
    with index.lock:
        table = index.nodes
        end = len(table) if before is None else bisect_left(table, before, key=lambda a: a.seq)
        start = max(0, end - limit)
        page = [replace(a) for a in reversed(table[start:end])]
        if not page:
            return NodePage([], [], None, index.dropped)
        low, high = table[start].seq, before if before is not None else float("inf")
        dividers = [(seq, list(retried)) for seq, retried in index.dividers if low <= seq < high]
        return NodePage(page, dividers, low if start > 0 else None, index.dropped)


def _window(index: Index, first: int) -> tuple[int, int, int]:
    """(the seq and byte offset of the last sparse entry at or before seq ``first``, the offset after the last complete
    line indexed)."""
    with index.lock:
        i = bisect_right(index.sparse, first, key=lambda s: s[0]) - 1
        seq, start = index.sparse[i] if i >= 0 else (0, 0)
        return seq, start, index.offset


def _lines(f: BinaryIO, start: int, stop: int) -> Iterator[bytes]:
    """The complete lines between byte ``start`` and byte ``stop``, one at a time."""
    f.seek(start)
    pos, parts = start, []
    while pos < stop and (chunk := f.read(min(CHUNK, stop - pos))):
        pos += len(chunk)
        s = 0
        while (nl := chunk.find(b"\n", s)) >= 0:
            parts.append(chunk[s:nl + 1])
            yield b"".join(parts)
            parts, s = [], nl + 1
        if s < len(chunk):
            parts.append(chunk[s:])


def _escape(key: object) -> str:
    return str(key).replace("~", "~0").replace("/", "~1")


def _cut(value: Any, path: str, cut: list[str]) -> Any:
    """``value`` with each string longer than FIELD_CHARS cut, its JSON pointer added to ``cut``."""
    if isinstance(value, str):
        if len(value) <= FIELD_CHARS:
            return value
        cut.append(path)
        return value[:FIELD_CHARS] + "…"
    if isinstance(value, dict):
        return {k: _cut(v, f"{path}/{_escape(k)}", cut) for k, v in value.items()}
    if isinstance(value, list):
        return [_cut(v, f"{path}/{i}", cut) for i, v in enumerate(value)]
    return value


def _node_of(payload: dict[str, Any] | None) -> str | None:
    if not payload:
        return None
    failure = payload.get("failure") if isinstance(payload.get("failure"), dict) else {}
    found = payload.get("node_id") or payload.get("spawner_id") or failure.get("node_id")
    return found if isinstance(found, str) else None


def _size(payload: dict[str, Any]) -> int:
    """``payload``'s size in bytes as UTF-8 JSON."""
    return len(json.dumps(payload, ensure_ascii=False).encode())


def _event(line: bytes, seq: int, scrub: Callable[[dict[str, Any]], dict[str, Any]], *,
           whole: bool) -> RunEvent | None:
    """Line ``seq`` as a page shows it (``whole``: as one opened record shows it, evidence included); None when it no
    longer parses as record ``seq`` (the file changed since it was indexed)."""
    if len(line) > BIG_LINE and not whole:
        head = _HEAD.match(line[:256])
        return RunEvent(seq=seq, kind=head[1].decode() if head else "unknown", size=len(line))
    try:
        record = json.loads(line)
    except ValueError:
        return None
    if not isinstance(record, dict) or record.get("seq") != seq:
        return None
    payload, left_out = record.get("payload"), False
    if isinstance(payload, dict) and not whole:
        for key in EVIDENCE:
            if payload.get(key) is not None:
                payload[key], left_out = None, True
    clean = scrub(record)
    kind = clean.get("kind") if isinstance(clean.get("kind"), str) and clean.get("kind") else "unknown"
    if "withheld" in clean:
        return RunEvent(seq=seq, kind=kind, node_id=clean.get("node_id"), withheld=clean["withheld"])
    payload = clean.get("payload") if isinstance(clean.get("payload"), dict) else None
    cut: list[str] = []
    if payload is not None and (not whole or _size(payload) > EVENT_BYTES):
        payload = _cut(payload, "", cut)
        if whole and _size(payload) > EVENT_BYTES:  # many short strings: cutting each can't bring it under
            return RunEvent(seq=seq, kind=kind, node_id=_node_of(payload), size=len(line))
    return RunEvent(seq=seq, kind=kind, node_id=_node_of(payload), payload=payload, cut=cut,
                    evidence_left_out=left_out)


def read_events(path: Path, index: Index, *, after: int | None, limit: int,
                scrub: Callable[[dict[str, Any]], dict[str, Any]]) -> RunEventPage:
    """Records after seq ``after`` (from the first when None), scrubbed, up to ``limit`` or PAGE_BYTES of JSON. A
    line's seq is its line number, counted from a sparse entry; a line that no longer matches ends the page there."""
    first = 0 if after is None else after + 1
    base, start, stop = _window(index, first)
    events: list[RunEvent] = []
    used, next_after, cut = 0, None, False
    with open(path, "rb") as f:
        for seq, line in enumerate(_lines(f, start, stop), base):
            if seq < first:
                continue
            event = _event(line, seq, scrub, whole=False)
            if event is None:  # rewritten since it was indexed: the next request's refresh rebuilds
                next_after = events[-1].seq if events else after
                break
            size = len(event.model_dump_json())
            if events and (len(events) >= limit or used + size > PAGE_BYTES):
                next_after, cut = events[-1].seq, len(events) < limit
                break
            events.append(event)
            used += size
    return RunEventPage(events=events, next_after=next_after, cut=cut)


def read_event(path: Path, index: Index, seq: int,
               scrub: Callable[[dict[str, Any]], dict[str, Any]]) -> RunEvent | None:
    """The record with ``seq``, scrubbed, evidence included; its strings cut only when its payload is over EVENT_BYTES,
    and a stub with its size when it is still over after that. None if there is none."""
    base, start, stop = _window(index, seq)
    with open(path, "rb") as f:
        for at, line in enumerate(_lines(f, start, stop), base):
            if at == seq:
                return _event(line, seq, scrub, whole=True)
    return None


def scrubbed_lines(path: Path, scrub_line: Callable[[bytes], bytes]) -> Iterator[bytes]:
    """Every complete line of ``path`` as it is when called, through ``scrub_line``: the download, one line in memory.
    The file is opened at once (FileNotFoundError here, not mid-stream). It needs no index, so a log this office
    can't read still downloads."""
    f = open(path, "rb")  # noqa: SIM115 - the generator below closes it
    size = os.fstat(f.fileno()).st_size

    def stream() -> Iterator[bytes]:
        with f:
            yield from (scrub_line(line) for line in _lines(f, 0, size))

    return stream()


def _stamp(st: os.stat_result) -> tuple[int, int, int, int]:
    return st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns


class RunLogReader:
    """The office's run-log indexes: built lazily per log on its first request, one build per log at a time, in a
    thread; kept, node table and all, in an LRU capped in bytes and logs, so a log is read whole once unless it is
    evicted. A log that can't be read isn't read again until its file changes. Use it on the office loop."""

    def __init__(self, *, budget: int = LRU_BYTES, logs: int = LRU_LOGS) -> None:
        self.budget, self.logs = budget, logs
        self._lru: OrderedDict[Path, Index] = OrderedDict()
        self._building: dict[Path, asyncio.Future[Index]] = {}
        self._progress: dict[Path, tuple[int, int]] = {}
        self._failed: dict[Path, tuple[tuple[int, int, int, int], UnreadableLog]] = {}

    async def index(self, path: Path) -> Index:
        """``path``'s index, brought up to date; concurrent callers share one build. Raises UnreadableLog (or
        UnsupportedSchema) and FileNotFoundError."""
        failed = self._failed.get(path)
        if failed is not None:
            if failed[0] == _stamp(os.stat(path)):
                raise failed[1]
            del self._failed[path]
        future = self._building.get(path)
        if future is None:
            future = self._build(path)
        try:
            index = await asyncio.shield(future)
        except Exception:
            self._lru.pop(path, None)
            raise
        self._keep(path, index)
        return index

    async def ready(self, path: Path, *, wait: float) -> Index | None:
        """``path``'s index if it is ready within ``wait`` seconds; else None, and the build goes on (``progress``)."""
        task = asyncio.ensure_future(self.index(path))
        task.add_done_callback(lambda t: t.cancelled() or t.exception())  # a failure is read by the next request
        try:
            return await asyncio.wait_for(asyncio.shield(task), wait)
        except TimeoutError:
            return None

    def progress(self, path: Path) -> tuple[int, int] | None:
        """(bytes read, file size) of the build in progress for ``path``, if any."""
        return self._progress.get(path)

    def _build(self, path: Path) -> asyncio.Future[Index]:
        def report(done: int, total: int) -> None:
            self._progress[path] = (done, total)

        def build() -> Index:
            st = os.stat(path)
            try:
                return refresh(path, self._lru.get(path), progress=report)
            except UnreadableLog as exc:
                if len(self._failed) >= self.logs:
                    self._failed.clear()
                self._failed[path] = (_stamp(st), exc)
                raise

        def done(finished: asyncio.Future[Index]) -> None:
            if self._building.get(path) is finished:
                del self._building[path]
                self._progress.pop(path, None)

        future = asyncio.ensure_future(asyncio.to_thread(build))
        self._building[path] = future
        future.add_done_callback(done)
        return future

    def _keep(self, path: Path, index: Index) -> None:
        self._lru[path] = index
        self._lru.move_to_end(path)
        while len(self._lru) > 1 and (len(self._lru) > self.logs
                                      or sum(i.cost() for i in self._lru.values()) > self.budget):
            self._lru.popitem(last=False)

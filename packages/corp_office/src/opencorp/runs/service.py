"""The Run Logs reads: the list of runs (the store and memory only) and, per run, its page."""

import asyncio
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from opencorp.protocol.models import (RunDetail, RunDivider, RunEvent, RunEventPage, RunNode, RunNodePage, RunPage,
                                      RunSummary, RunUsage, Session)
from opencorp.runs.known import KnownValues, SecretsUnavailable
from opencorp.runs.outcomes import DEBRIEF
from opencorp.runs.reader import (ERROR_CHARS, RunLogReader, UnreadableLog, node_page, read_event, read_events,
                                  scrubbed_lines)
from opencorp.runs.records import Live, Summaries, shown_reason
from opencorp.runs.scrub import Scrubber, scrub_string
from opencorp.store import RunRow

PAGE = 50
BATCH = 100
"""How many rows a filtered list reads at a time."""
SCAN_CAP = 1_000
"""The most runs one list request looks at to fill a filtered page; ``next`` resumes after them."""
REASON_HIDDEN = "hidden: couldn't load the secrets to remove"
OPEN_STATUSES = frozenset({"running", "waiting", "idle"})
"""The statuses of a run with no outcome only (an interrupted one may have either)."""
INDEX_WAIT_S = 2.0
"""How long a run page read waits for a first index build before answering ``indexing``."""
NOT_STARTED = "no run log: the run didn't start"
NOT_STARTED_YET = "not started yet"
LOG_GONE = "the run log is gone"


class NoLog(LookupError):
    """The run has no log to read: it didn't start, or the file is gone."""


class Indexing(Exception):
    """The log's first index build is still going: one record can't be found before it ends."""


@dataclass(frozen=True)
class RunFilter:
    """The list's filters: a run matches all that are set (any one of ``statuses``); ``since`` and ``until`` bound its
    launch time; with ``recent``, a run matches when it's open (running, waiting or idle) or launched at or after it.
    A top-level run shows when it or a run it started matches.

    The store applies the launch range to the rows it pages: top-level rows launched in it or with a child launched in
    it, exactly the ones the range alone shows. So only the other filters need summaries. For ``recent`` it pages the
    rows with no outcome or launched since, and a summary says which of those with no outcome are open.
    """

    flow: str | None = None
    person: str | None = None
    statuses: frozenset[str] = frozenset()
    q: str | None = None
    since: str | None = None
    until: str | None = None
    recent: str | None = None

    @property
    def summaries_needed(self) -> bool:
        """Whether matching a run needs more than its row's launch time."""
        return bool(self.flow or self.person or self.statuses or self.q or self.recent)

    @property
    def open_only(self) -> bool:
        """Whether only runs with no outcome yet can match: every wanted status is one of an open run."""
        return bool(self.statuses) and self.statuses <= OPEN_STATUSES

    def matches(self, run: RunSummary) -> bool:
        return ((not self.flow or run.flow == self.flow)
                and (not self.person or run.driver == self.person or self.person in run.participants)
                and (not self.statuses or run.status in self.statuses)
                and (not self.q or self.q.upper() in run.run_id)
                and (not self.since or run.launched_at >= self.since)
                and (not self.until or run.launched_at < self.until)
                and (not self.recent or run.status in OPEN_STATUSES or run.launched_at >= self.recent))


class RunLogs:
    """The Run Logs reads, on ``office.extras["runs"]``. ``known`` gives the known secret values every reason, node
    error and record loses when served; without it (tests), only secret shapes are removed."""

    def __init__(self, office: Any, *, known: KnownValues | None = None) -> None:
        self.office, self.store, self.known = office, office.store, known
        self.reader = RunLogReader()

    async def scrubber(self) -> Scrubber:
        """A scrub with the known values of now; SecretsUnavailable if they can't be read."""
        return Scrubber(()) if self.known is None else await self.known.scrubber()

    async def _reasons(self) -> Callable[[str], str]:
        """How reasons are cleaned to be shown: ``shown_reason`` with the full scrub (an earlier cut's partial word
        dropped, the scrub, then the cut to REASON_CHARS, so no secret shows in part); REASON_HIDDEN for each when the
        known values can't be read, so the list and a run's header still answer."""
        try:
            scrubber = await self.scrubber()
        except SecretsUnavailable:
            return lambda text: REASON_HIDDEN
        return lambda text: shown_reason(text, scrubber.text)

    def live(self) -> Live:
        """What the harness and learning hold now."""
        harness, learning = self.office.extras.get("harness"), self.office.extras.get("learning")
        runs, waking = harness.live_runs() if harness is not None else ({}, frozenset())
        debriefs = learning.debriefing() if learning is not None else {}

        def nodes(run_id: str) -> list[str]:
            return ((harness.open_nodes(run_id) if harness is not None else [])
                    or (learning.open_nodes(run_id) if learning is not None else []))

        return Live(runs=frozenset(runs.items()), waking=frozenset(waking), debriefs=frozenset(debriefs.items()),
                    nodes=nodes)

    def log_path(self, row: RunRow) -> Path:
        """Where a run's log is: derived from the office's paths, never stored (the home has moved before)."""
        return Path(self.office.paths.run_dir(row.session_id)) / "runs" / f"{row.run_id}.jsonl"

    def _one(self, run_id: str) -> tuple[RunRow, Session]:
        row = self.store.get_run(run_id)
        session = self.store.get_session(row.session_id) if row is not None else None
        if row is None or session is None:
            raise LookupError(f"no run {run_id}")
        return row, session

    def _with_family(self, row: RunRow, clean: Callable[[str], str]) -> tuple[RunSummary, RunSummary | None]:
        """The run's summary with its children (the newest CHILDREN_SHOWN), and its parent's, each reason through
        ``clean``; read as ``_page`` reads (memory, one store snapshot, memory again)."""
        summaries = Summaries(self.store, self.live(), fresh=self.live, clean=clean)
        with self.store.snapshot():
            run = summaries.build([row], children={row.run_id: self.store.run_children([row.run_id])})[row.run_id]
            parent_row = self.store.get_run(row.parent_run_id) if row.parent_run_id else None
            parent = summaries.build([parent_row]).get(parent_row.run_id) if parent_row else None
        return run, parent

    def _progress(self, path: Path) -> dict[str, Any]:
        """``indexing`` fields: bytes read so far of the log's size."""
        try:
            done, total = self.reader.progress(path) or (0, path.stat().st_size)
        except FileNotFoundError:
            done, total = 0, 0
        return {"bytes_done": done, "bytes_total": total}

    async def detail(self, run_id: str) -> RunDetail:
        """A run page's header: the run with its parent and children (reasons fully scrubbed), usage (harness runs
        only), what its log's first record says, and whether the log can be read; LookupError if there is no such
        run. Waits up to INDEX_WAIT_S for a first index build."""
        row, session = await asyncio.to_thread(self._one, run_id)
        run, parent = await asyncio.to_thread(self._with_family, row, await self._reasons())
        usage = None
        if row.flow != DEBRIEF:  # the office records usage only in the chat harness (_charge)
            tokens_in, tokens_out, usd = await asyncio.to_thread(self.store.run_usage, row.run_id)
            usage = RunUsage(input_tokens=tokens_in, output_tokens=tokens_out, usd=usd)
        return RunDetail(run=run, parent=parent, repo_commit=session.repo_commit, usage=usage,
                         **await self._log_state(row))

    async def _log_state(self, row: RunRow) -> dict[str, Any]:
        path = self.log_path(row)
        if not path.exists():
            if row.outcome is None or (row.outcome == "failed" and row.failed_node is None):
                return {"log_state": "not_started", "log_message": NOT_STARTED if row.outcome else NOT_STARTED_YET}
            return {"log_state": "missing", "log_message": LOG_GONE}
        try:
            index = await self.reader.ready(path, wait=INDEX_WAIT_S)
        except UnreadableLog as exc:  # an unknown or retired schema, a line that isn't a record, seqs out of order
            return {"log_state": "unsupported_schema", "log_message": str(exc)}
        except FileNotFoundError:
            return {"log_state": "missing", "log_message": LOG_GONE}
        if index is None:
            progress = self._progress(path)
            return {"log_state": "indexing", **progress, "log_message":
                    f"reading the log: {progress['bytes_done'] >> 20} of {progress['bytes_total'] >> 20} MB"}
        return {"log_state": "ok", "flow_fingerprint": index.fingerprint, "learnable": index.learnable,
                "models": {static: scrub_string(model) for static, model in index.models.items()}}

    async def _log(self, run_id: str) -> tuple[RunRow, Path]:
        row, _ = await asyncio.to_thread(self._one, run_id)
        path = self.log_path(row)
        if not path.exists():
            raise NoLog(f"run {run_id} has no log")
        return row, path

    async def nodes(self, run_id: str, *, before: int | None, limit: int) -> RunNodePage:
        """Node attempts that started before seq ``before``, newest first, with scrubbed errors; ``indexing`` while a
        first index build runs past INDEX_WAIT_S. ``kind`` stays null until Yian lists a flow's nodes (yian#943)."""
        _, path = await self._log(run_id)
        index = await self.reader.ready(path, wait=INDEX_WAIT_S)
        if index is None:
            return RunNodePage(nodes=[], indexing=True, **self._progress(path))
        scrubber = await self.scrubber()
        page = node_page(index, before=before, limit=limit)
        return RunNodePage(
            nodes=[RunNode(seq=a.seq, end_seq=a.end_seq, node_id=a.node_id, status=a.status, handle=a.handle,
                           error=scrubber.text(a.error)[:ERROR_CHARS] if a.error else None) for a in page.nodes],
            dividers=[RunDivider(seq=seq, retried=retried) for seq, retried in page.dividers],
            next_before=page.next_before, dropped=page.dropped)

    async def events(self, run_id: str, *, after: int | None, limit: int) -> RunEventPage:
        """Records after seq ``after``, scrubbed, evidence left out; ``indexing`` while a first build runs."""
        _, path = await self._log(run_id)
        index = await self.reader.ready(path, wait=INDEX_WAIT_S)
        if index is None:
            return RunEventPage(events=[], indexing=True, **self._progress(path))
        scrubber = await self.scrubber()
        return await asyncio.to_thread(read_events, path, index, after=after, limit=limit, scrub=scrubber.record)

    async def event(self, run_id: str, seq: int) -> RunEvent:
        """The record with ``seq``, scrubbed, evidence included; LookupError if there is none, Indexing while a first
        build runs."""
        _, path = await self._log(run_id)
        index = await self.reader.ready(path, wait=INDEX_WAIT_S)
        if index is None:
            raise Indexing(f"run {run_id}'s log is still being read")
        scrubber = await self.scrubber()
        found = await asyncio.to_thread(read_event, path, index, seq, scrubber.record)
        if found is None:
            raise LookupError(f"run {run_id} has no record {seq}")
        return found

    async def log_lines(self, run_id: str) -> Iterator[bytes]:
        """The whole log as it is now, each line scrubbed as it streams. It needs no index, and the scrub doesn't
        depend on the schema, so a log this office can't read still downloads. The log is opened before this returns,
        so one removed meanwhile is NoLog, not a cut-off download."""
        _, path = await self._log(run_id)
        scrubber = await self.scrubber()
        try:
            return scrubbed_lines(path, scrubber.line)
        except FileNotFoundError:
            raise NoLog(f"run {run_id} has no log") from None

    async def page(self, *, flow: str | None = None, person: str | None = None, status: Iterable[str] = (),
                   q: str | None = None, since: str | None = None, until: str | None = None,
                   recent: str | None = None, before: str | None = None, limit: int = PAGE) -> RunPage:
        """Top-level runs after run ``before`` (newest first) that the filters show, at most ``limit``: a run shows
        when it or a run it started matches. Each carries how many runs it started, not the runs; reasons are
        scrubbed with the known values of now."""
        wanted = RunFilter(flow, person, frozenset(status), q.strip() if q else None, since, until, recent)
        return await asyncio.to_thread(self._page, wanted, None, before, limit, await self._reasons())

    async def children(self, parent: str, *, flow: str | None = None, person: str | None = None,
                       status: Iterable[str] = (), q: str | None = None, since: str | None = None,
                       until: str | None = None, recent: str | None = None, before: str | None = None,
                       limit: int = PAGE) -> RunPage:
        """The runs started from run ``parent`` that match the filters, paged as ``page`` is; LookupError if
        ``parent`` has no row."""
        wanted = RunFilter(flow, person, frozenset(status), q.strip() if q else None, since, until, recent)
        return await asyncio.to_thread(self._page, wanted, parent, before, limit, await self._reasons())

    def _page(self, wanted: RunFilter, parent: str | None, before: str | None, limit: int,
              clean: Callable[[str], str]) -> RunPage:
        """A page of top-level runs, or of ``parent``'s children, from the store and memory (blocking).

        The store pages rows in the launch range. Other filters are applied to summaries built a batch of rows at a
        time, so a filtered page may stop after SCAN_CAP rows with fewer runs; ``next`` resumes.

        Memory is read first, then every store read is one snapshot, then memory again per batch (``Summaries``): a
        run that ends or starts while the page is built never reads as interrupted.
        """
        summaries = Summaries(self.store, self.live(), fresh=self.live, clean=clean)
        with self.store.snapshot():
            if parent is not None and self.store.get_run(parent) is None:
                raise LookupError(parent)
            return self._rows(wanted, parent, before, limit, summaries)

    def _rows(self, wanted: RunFilter, parent: str | None, before: str | None, limit: int,
              summaries: Summaries) -> RunPage:
        out: list[RunSummary] = []
        cursor, scanned, exhausted = before, 0, False
        while len(out) < limit and scanned < SCAN_CAP:
            ask = min(BATCH, SCAN_CAP - scanned) if wanted.summaries_needed else limit - len(out)
            rows = self.store.run_page(before=cursor, limit=ask, parent=parent, since=wanted.since,
                                       until=wanted.until, recent=wanted.recent)
            built = summaries.build(rows)
            kids = self._matching_children(rows, wanted, summaries) if parent is None else set()
            for row in rows:
                scanned, cursor = scanned + 1, row.run_id
                run = built.get(row.run_id)
                # Without filters past the range, every row the store gave shows (a top-level one launched before the
                # range is there for a child launched in it).
                if run is not None and (not wanted.summaries_needed or wanted.matches(run) or row.run_id in kids):
                    out.append(run)
                    if len(out) == limit:
                        break
            if len(rows) < ask:  # the store has nothing after these rows
                exhausted = not rows or cursor == rows[-1].run_id
                break
        more = not exhausted and cursor is not None and bool(
            self.store.run_page(before=cursor, limit=1, parent=parent, since=wanted.since, until=wanted.until,
                                recent=wanted.recent))
        return RunPage(runs=out, next=cursor if more else None)

    def _matching_children(self, rows: list[RunRow], wanted: RunFilter, summaries: Summaries) -> set[str]:
        """The ids of those of ``rows`` with a child that matches ``wanted`` (none to check without filters). The store
        leaves out the children the launch range, ``recent`` or an open-only status filter can't match."""
        if not rows or not wanted.summaries_needed:
            return set()
        kids = self.store.run_children([r.run_id for r in rows], since=wanted.since, until=wanted.until,
                                       recent=wanted.recent, open_only=wanted.open_only)
        built = summaries.build(kids)
        return {k.parent_run_id for k in kids if k.run_id in built and wanted.matches(built[k.run_id])}

"""The Run Logs reads: the list of runs (the store and memory only) and, per run, its page."""

import asyncio
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any

from opencorp.protocol.models import RunPage, RunSummary
from opencorp.runs.known import KnownValues, SecretsUnavailable
from opencorp.runs.records import Live, Summaries
from opencorp.runs.scrub import Scrubber
from opencorp.store import RunRow, cut_reason

PAGE = 50
BATCH = 100
"""How many rows a filtered list reads at a time."""
SCAN_CAP = 1_000
"""The most runs one list request looks at to fill a filtered page; ``next`` resumes after them."""
REASON_HIDDEN = "hidden: couldn't load the secrets to remove"
OPEN_STATUSES = frozenset({"running", "waiting", "idle"})
"""The statuses of a run with no outcome only (an interrupted one may have either)."""


@dataclass(frozen=True)
class RunFilter:
    """The list's filters: a run matches all that are set (any one of ``statuses``); ``since`` and ``until`` bound its
    launch time. A top-level run shows when it or a run it started matches.

    The store applies the launch range to the rows it pages: top-level rows launched in it or with a child launched in
    it, exactly the ones the range alone shows. So only the other filters need summaries.
    """

    flow: str | None = None
    person: str | None = None
    statuses: frozenset[str] = frozenset()
    q: str | None = None
    since: str | None = None
    until: str | None = None

    @property
    def summaries_needed(self) -> bool:
        """Whether matching a run needs more than its row's launch time."""
        return bool(self.flow or self.person or self.statuses or self.q)

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
                and (not self.until or run.launched_at < self.until))


class RunLogs:
    """The Run Logs reads, on ``office.extras["runs"]``. ``known`` gives the known secret values every reason, node
    error and record loses when served; without it (tests), only secret shapes are removed."""

    def __init__(self, office: Any, *, known: KnownValues | None = None) -> None:
        self.office, self.store, self.known = office, office.store, known

    async def scrubber(self) -> Scrubber:
        """A scrub with the known values of now; SecretsUnavailable if they can't be read."""
        return Scrubber(()) if self.known is None else await self.known.scrubber()

    async def _reasons(self) -> Callable[[str], str]:
        """How reasons are cleaned to be shown: the full scrub, then the cut to REASON_CHARS (after, so no secret is
        cut in two before it's found); REASON_HIDDEN for each when the known values can't be read, so the list and a
        run's header still answer."""
        try:
            scrubber = await self.scrubber()
        except SecretsUnavailable:
            return lambda text: REASON_HIDDEN
        return lambda text: cut_reason(scrubber.text(text))

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

    async def page(self, *, flow: str | None = None, person: str | None = None, status: Iterable[str] = (),
                   q: str | None = None, since: str | None = None, until: str | None = None,
                   before: str | None = None, limit: int = PAGE) -> RunPage:
        """Top-level runs after run ``before`` (newest first) that the filters show, at most ``limit``: a run shows
        when it or a run it started matches. Each carries how many runs it started, not the runs; reasons are
        scrubbed with the known values of now."""
        wanted = RunFilter(flow, person, frozenset(status), q.strip() if q else None, since, until)
        return await asyncio.to_thread(self._page, wanted, None, before, limit, await self._reasons())

    async def children(self, parent: str, *, flow: str | None = None, person: str | None = None,
                       status: Iterable[str] = (), q: str | None = None, since: str | None = None,
                       until: str | None = None, before: str | None = None, limit: int = PAGE) -> RunPage:
        """The runs started from run ``parent`` that match the filters, paged as ``page`` is; LookupError if
        ``parent`` has no row."""
        wanted = RunFilter(flow, person, frozenset(status), q.strip() if q else None, since, until)
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
                                       until=wanted.until)
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
            self.store.run_page(before=cursor, limit=1, parent=parent, since=wanted.since, until=wanted.until))
        return RunPage(runs=out, next=cursor if more else None)

    def _matching_children(self, rows: list[RunRow], wanted: RunFilter, summaries: Summaries) -> set[str]:
        """The ids of those of ``rows`` with a child that matches ``wanted`` (none to check without filters). The store
        leaves out the children the launch range or an open-only status filter can't match."""
        if not rows or not wanted.summaries_needed:
            return set()
        kids = self.store.run_children([r.run_id for r in rows], since=wanted.since, until=wanted.until,
                                       open_only=wanted.open_only)
        built = summaries.build(kids)
        return {k.parent_run_id for k in kids if k.run_id in built and wanted.matches(built[k.run_id])}

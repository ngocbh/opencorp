"""Run summaries for the Run Logs list and run pages: status, participants, current nodes and replaces, from the runs
table, sessions, questions and memory. Nothing here opens a run log."""

import logging
import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass

from opencorp.chat.turns import MAIN_CHAT
from opencorp.protocol.models import Question, RunSummary, Session
from opencorp.runs.outcomes import DEBRIEF, FLOWS
from opencorp.store import RunRow, Store, cut_reason

log = logging.getLogger(__name__)

NO_OUTCOME = "ended without a recorded outcome"
CHILDREN_SHOWN = 200
"""The most children a run's page shows with it (the newest)."""
SIDE_CHAT = FLOWS["side"]
_RUNNING = ("starting", "busy", "ending")
_CUT_TAIL = re.compile(r"\S*…\Z")
"""The word a cut before the reason was stored left in part, with the cut's ellipsis: a secret cut short there can't
be matched by the scrub."""
_HANDLE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$")
WARNED_CAP = 10_000
_warned: set[str] = set()  # runs already warned about; cleared at WARNED_CAP so it stays small


@dataclass(frozen=True)
class Live:
    """What memory says about runs (one read, or several merged): the sessions' live runs and learning's debriefs in
    flight, each as (session id, run id) pairs, the sessions being started, woken or finishing, and a run's open
    nodes."""

    runs: frozenset[tuple[str, str]] = frozenset()
    waking: frozenset[str] = frozenset()
    debriefs: frozenset[tuple[str, str]] = frozenset()
    nodes: Callable[[str], list[str]] = lambda run_id: []

    def merged(self, later: "Live") -> "Live":
        """Both reads at once: a run is live, waking or debriefing when either read says so; open nodes are
        ``later``'s."""
        return Live(runs=self.runs | later.runs, waking=self.waking | later.waking,
                    debriefs=self.debriefs | later.debriefs, nodes=later.nodes)


def status_of(row: RunRow, session: Session | None, live: Live) -> tuple[str, str | None]:
    """A run's status and reason; the first rule that matches wins."""
    if row.outcome is not None:
        return row.outcome, row.reason
    current = session is not None and session.run_ids[-1:] == [row.run_id]
    if current and session.status in ("waiting", "idle"):
        return session.status, None
    if current and session.status in _RUNNING and ((session.id, row.run_id) in live.runs
                                                   or session.id in live.waking or session.status == "starting"):
        return "running", None
    if session is not None and (session.id, row.run_id) in live.debriefs:
        return "running", None
    if row.run_id not in _warned:  # a missing end path: say so once per run
        if len(_warned) >= WARNED_CAP:
            _warned.clear()
        _warned.add(row.run_id)
        log.warning("run %s has no recorded outcome and nothing runs it", row.run_id)
    return "interrupted", NO_OUTCOME


def current_nodes(status: str, run_id: str, open_questions: list[Question], live: Live) -> tuple[list[str], bool, bool]:
    """(the node ids a run in ``status`` is at, whether a model question is open, whether it's held at its cost cap)."""
    if status == "idle":
        turns = [q.node_id for q in open_questions if q.source == "human_input" and MAIN_CHAT.is_turn(q.node_id)]
        return turns, False, False
    if status == "waiting":
        nodes = [q.node_id for q in open_questions
                 if q.node_id and not (q.source == "human_input" and MAIN_CHAT.is_turn(q.node_id))]
        asking = any(q.node_id is None for q in open_questions)
        if asking:
            nodes += [n for n in live.nodes(run_id) if n not in nodes]  # the asking node, when the run is in memory
        return nodes, asking, not nodes and not asking
    if status == "running":
        return live.nodes(run_id), False, False
    return [], False, False


def shown_reason(reason: str, scrub: Callable[[str], str] = lambda text: text) -> str:
    """``reason`` as shown: the partial word before an earlier cut's "…" dropped, then ``scrub``, then the cut to
    REASON_CHARS (after the scrub, so it never splits a secret the scrub would find)."""
    return cut_reason(scrub(_CUT_TAIL.sub("…", reason)))


def participants(driver: str, person: str, others: Iterable[str | None]) -> list[str]:
    """The employee, then everyone else in order, never the driver, each once."""
    out: list[str] = []
    for who in (person, *others):
        if who and who != driver and who not in out and _HANDLE.fullmatch(who):
            out.append(who)
    return out


class Summaries:
    """RunSummary objects for a batch of rows, with one store read per kind of fact (and one per session).

    ``live`` is read before the store; ``fresh`` (when given) reads memory again after the store reads of each build,
    and the two are merged. A run that ends between the reads is live in the first and still open in the store; one
    that starts between them is live in the second. ``clean`` makes a stored reason one to show (by default,
    ``shown_reason`` with no scrub).
    """

    def __init__(self, store: Store, live: Live, *, fresh: Callable[[], Live] | None = None,
                 clean: Callable[[str], str] = shown_reason) -> None:
        self.store, self.live, self.fresh, self.clean = store, live, fresh, clean

    def build(self, rows: list[RunRow], *, children: Mapping[str, list[RunRow]] | None = None
              ) -> dict[str, RunSummary]:
        """Each row's summary by run id, with how many runs it started (``children_total``) and no children. Given
        ``children`` (by parent id, newest first), the newest CHILDREN_SHOWN of each are summarized and attached. A row
        whose session is gone is left out."""
        children = children or {}
        everyone = list({r.run_id: r for r in [*rows, *(k for ks in children.values() for k in ks[:CHILDREN_SHOWN])]}
                        .values())
        ids = [r.run_id for r in everyone]
        sessions = {sid: self.store.get_session(sid) for sid in {r.session_id for r in everyone}}
        questions: dict[str, list[Question]] = {}
        if everyone:
            for q in self.store.list_questions(run_id=ids):
                questions.setdefault(q.run_id, []).append(q)
        counts = self.store.run_child_counts(ids)
        openers = self.store.child_drivers(ids, SIDE_CHAT)
        neighbours = self._neighbours(everyone, sessions)
        live = self.live if self.fresh is None else self.live.merged(self.fresh())
        out = {r.run_id: self._one(r, sessions[r.session_id], questions.get(r.run_id, []), openers.get(r.run_id, []),
                                   neighbours[r.run_id], counts.get(r.run_id, 0), live)
               for r in everyone if sessions.get(r.session_id) is not None}
        for pid, ks in children.items():
            if pid in out:
                shown = [out[k.run_id] for k in ks[:CHILDREN_SHOWN] if k.run_id in out]
                out[pid] = out[pid].model_copy(update={"children": shown})
        return out

    def _one(self, row: RunRow, session: Session, questions: list[Question], openers: list[str],
             neighbours: tuple[str | None, str | None], children_total: int, live: Live) -> RunSummary:
        status, reason = status_of(row, session, live)
        nodes, asking, held = current_nodes(status, row.run_id, [q for q in questions if q.status == "open"], live)
        answerers = [q.answered_by for q in questions if q.answered_by]
        return RunSummary(
            run_id=row.run_id, session_id=row.session_id, flow=row.flow, flow_path=row.flow_path,
            person=session.person, driver=row.driver,
            participants=participants(row.driver, session.person, [*answerers, *openers]),
            parent_run_id=row.parent_run_id, status=status, reason=self.clean(reason) if reason else None,
            failed_node=row.failed_node,
            current_nodes=nodes, asking=asking, held=held, codex=row.flow == DEBRIEF and session.harness == "codex",
            launched_at=row.launched_at, ended_at=row.ended_at, replaces=neighbours[0], replaced_by=neighbours[1],
            children_total=children_total)

    def _neighbours(self, rows: list[RunRow], sessions: Mapping[str, Session | None]
                    ) -> dict[str, tuple[str | None, str | None]]:
        """(the run each row replaces, the run that replaced it). ``_new_run`` writes the old run's end and the new
        run's launch from one ``now()`` in one transaction; adjacent runs of a session whose times don't meet (a
        reopened side chat) don't replace each other."""
        pairs: dict[str, tuple[str | None, str | None]] = {}
        for r in rows:
            s = sessions.get(r.session_id)
            ids = s.run_ids if s is not None else []
            i = ids.index(r.run_id) if r.run_id in ids else -1
            pairs[r.run_id] = ((ids[i - 1] if i > 0 else None), (ids[i + 1] if 0 <= i < len(ids) - 1 else None))
        found = self.store.get_runs({x for p in pairs.values() for x in p if x}) | {r.run_id: r for r in rows}
        out = {}
        for r in rows:
            before, after = (found.get(x) if x else None for x in pairs[r.run_id])
            out[r.run_id] = (before.run_id if before and before.ended_at and before.ended_at == r.launched_at else None,
                             after.run_id if after and r.ended_at and r.ended_at == after.launched_at else None)
        return out

"""Learning: debrief each finished main session, apply queued feedback through backward jobs, and the profile manager."""

import asyncio
import logging
import queue
import threading
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from agent_corp.chat.harness import LIVE, Harness, HarnessError
from agent_corp.company.loader import load_repo
from agent_corp.profile import GitProfileStore
from agent_corp.profile.debrief import DEBRIEF_FLOW, confirm_follow_ups, pending_debrief, ready_debrief, transcript_text
from agent_corp.profile.feedback import FeedbackHandlers, next_status
from agent_corp.protocol import now
from agent_corp.protocol.models import CompanyDefaults, Debrief, Feedback, FeedbackRequest, Session
from agent_corp.store import new_id
from agent_corp.worker import Job, ProfileMemorySpec, Worker, group_specs

log = logging.getLogger(__name__)

TICK_SECONDS = 60.0
"""How often pending debriefs and feedback waiting to retry are tried again."""
MAX_DEBRIEFS = 3
"""Debrief runs that may fail before the tick stops retrying; ``GET /debriefs/{session}`` always retries."""
_BUSY = (*LIVE, "debriefing")


class Learning:
    """Debriefs, the feedback queue, and the profile manager, on top of the chat harness.

    Hook callbacks and route calls hand work to one thread, which starts every debrief and
    backward worker, so a session never gets two. ``tick`` is the retry period in seconds
    (None: only ``tick()`` retries, for tests).
    """

    def __init__(self, office: Any, harness: Harness, *, tick: float | None = TICK_SECONDS) -> None:
        self.office, self.harness = office, harness
        self.store, self.git, self.registry = office.store, office.git, harness.registry
        self.tick_seconds = tick
        self._lock = threading.Lock()
        self._confirming = threading.Lock()
        self._active: dict[str, Worker | None] = {}  # session id -> its debrief or backward worker
        self._waiting: set[str] = set()  # feedback that failed and waits for the next tick
        self._jobs: queue.Queue[tuple[Callable[..., Any], tuple[Any, ...]] | None] = queue.Queue()
        self._thread = threading.Thread(target=self._run, name="learning", daemon=True)
        self._timer: threading.Timer | None = None
        self._stopping = False
        harness.hooks.end_status.append(self._end_status)
        harness.hooks.run_finished.append(self._run_finished)
        harness.hooks.session_ended.append(self._session_ended)

    # --- life cycle ------------------------------------------------------------------

    def start(self) -> None:
        """Start the thread; pick up debriefs and feedback an earlier office left unfinished."""
        for feedback in self.store.list_feedback(status="learning"):
            self.store.set_feedback_status(feedback.id, "queued")  # its worker was killed with the office
        self._thread.start()
        self._post(self._recover)
        self._schedule()

    def stop(self) -> None:
        """Stop the thread and the timer, then the debrief and backward workers still running.

        The thread stops first, so a worker killed here doesn't count as an attempt: its session
        stays ``debriefing`` (or its Debrief pending) and the next start picks it up. A second
        call does nothing, and so does a call before ``start``, apart from refusing new work.
        """
        with self._lock:
            if self._stopping:
                return
            self._stopping = True
            if self._timer is not None:
                self._timer.cancel()
        self._jobs.put(None)
        if self._thread.is_alive():
            self._thread.join(10)
        with self._lock:
            workers = [w for w in self._active.values() if w is not None]
        for worker in workers:
            if self.registry.get(worker.session_id) is worker:
                self.registry.close(worker.session_id)

    def tick(self) -> None:
        """Retry pending debriefs and feedback that failed, now."""
        self._post(self._tick)

    # --- routes ----------------------------------------------------------------------

    def add_feedback(self, request: FeedbackRequest) -> Feedback:
        """Queue feedback on a finished run of a session (its latest run by default)."""
        session = self._session(request.session_id)
        if session.kind != "main":
            raise HarnessError(422, "not_learnable", f"session {session.id} is a {session.kind} session")
        run_id = request.run_id or (session.run_ids[-1] if session.run_ids else None)
        record = self.store.get_debrief_record(session.id)
        runs = set(session.run_ids) | ({record.run_id} if record and record.debrief.state == "ready" else set())
        if run_id is None or run_id not in runs:
            raise HarnessError(422, "invalid_body", f"session {session.id} has no run {run_id}")
        if not self._finished(session.id, run_id):
            raise HarnessError(409, "run_unfinished", f"run {run_id} didn't finish, so it can't take feedback")
        feedback = self.store.add_feedback(Feedback(
            id=new_id(), session_id=session.id, run_id=run_id, author=self._owner(), text=request.text,
            status="queued", created_at=now()))
        self._post(self._drain, session.id)
        return feedback

    def debrief(self, session_id: str) -> Debrief:
        """The session's debrief, pending from ``debriefing`` on; a pending one is retried if none runs."""
        session = self._session(session_id)
        record = self.store.get_debrief_record(session_id)
        if record is None:
            if session.status == "debriefing":
                return pending_debrief(session)  # its debrief run hasn't stored the record yet
            raise HarnessError(404, "not_found", f"session {session_id} has no debrief")
        if record.debrief.state == "pending" and session.status not in _BUSY:
            self._post(self._retry_debrief, session_id)
        return record.debrief

    def confirm(self, session_id: str, indices: Iterable[int]) -> Debrief:
        """Confirm follow-ups of the session's debrief: one work item each."""
        session = self._session(session_id)
        with self._confirming:
            try:
                return confirm_follow_ups(self.store, session, indices, requester=self._owner())
            except IndexError as exc:
                raise HarnessError(422, "invalid_body", str(exc)) from exc
            except LookupError as exc:
                raise HarnessError(409, "not_ready", str(exc)) from exc

    # --- hooks (on the harness's thread: hand work to ours) ---------------------------

    def _end_status(self, session: Session) -> str | None:
        return "debriefing" if session.kind == "main" else None

    def _run_finished(self, session: Session, run_id: str, outcome: dict[str, Any] | None) -> None:
        if outcome is not None and outcome.get("type") == "result":
            self._mark_finished(session.id, run_id)  # before session_ended, so feedback on it is taken

    def _session_ended(self, session: Session) -> None:
        self._post(self._ended, session.id)

    # --- work, on our thread ----------------------------------------------------------

    def _undebriefed(self, session: Session) -> bool:
        """A main session that failed after a run and has no debrief: it gets one, as an ended one does."""
        return (session.kind == "main" and session.status == "failed" and bool(session.run_ids)
                and self.store.get_debrief_record(session.id) is None)

    def _ended(self, session_id: str) -> None:
        session = self.store.get_session(session_id)
        if session.status == "debriefing" or self._undebriefed(session):
            self._debrief(session)
        else:
            self._drain(session_id)

    def _recover(self) -> None:
        for session in self.store.list_sessions(status="debriefing", kind="main", limit=None):
            self._debrief(session)
        self._tick()

    def _tick(self) -> None:
        self._waiting.clear()
        for record in self.store.list_debrief_records(state="pending"):
            session = self.store.get_session(record.debrief.session_id)
            if record.attempts < MAX_DEBRIEFS and session.status not in _BUSY:
                self._debrief(session)
        for session in self.store.list_sessions(status="failed", kind="main", limit=None):
            if self._undebriefed(session):  # also one whose failure fired no hook, such as a failed restore
                self._debrief(session)
        for session_id in dict.fromkeys(f.session_id for f in self.store.list_feedback(status="queued")):
            self._drain(session_id)

    def _retry_debrief(self, session_id: str) -> None:
        record = self.store.get_debrief_record(session_id)
        session = self.store.get_session(session_id)
        if record.debrief.state == "pending" and session.status not in _BUSY:
            self._debrief(session)

    def _debrief(self, session: Session) -> None:
        """Start a debrief run on the session's transcript; the Debrief is pending until it succeeds."""
        if not self._reserve(session.id):
            return
        if self.store.get_debrief_record(session.id) is None:
            self.store.save_debrief(pending_debrief(session))  # the session shows "debrief pending" meanwhile
        run_id = new_id()
        try:
            job, stores = self._debrief_job(session, run_id, kind="chat")
            handlers = FeedbackHandlers(stores=stores,
                                        exited=lambda outcome: self._post(self._debriefed, session.id, run_id, outcome))
            self._started(session.id, self.registry.spawn(job, self._run_dir(session.id), handlers))
        except Exception:
            log.exception("can't start the debrief of session %s", session.id)
            self._debriefed(session.id, run_id, None)

    def _debriefed(self, session_id: str, run_id: str, outcome: dict[str, Any] | None) -> None:
        self._release(session_id)
        session = self.store.get_session(session_id)
        attempts = self.store.get_debrief_record(session_id).attempts + 1
        debrief = None
        if outcome is not None and outcome.get("type") == "result" and outcome.get("status") == "succeeded":
            try:
                debrief = ready_debrief(session, outcome["output"])
            except (KeyError, TypeError, ValidationError):
                log.exception("the debrief of session %s returned a bad output", session_id)
        else:
            log.warning("the debrief of session %s failed: %s", session_id, outcome)
        if debrief is not None:
            self._mark_finished(session_id, run_id)
            self.store.save_debrief(debrief, run_id=run_id, attempts=attempts)
        else:
            self.store.save_debrief(pending_debrief(session), attempts=attempts)
        if session.status == "debriefing":
            self.store.update_session(session_id, status="ended")
        self._drain(session_id)

    def _drain(self, session_id: str) -> None:
        """Start a backward job for the session's oldest queued feedback once nothing else of it runs."""
        with self._lock:
            if self._stopping or session_id in self._active:
                return
        session = self.store.get_session(session_id)
        if session is None or session.status in _BUSY or self.registry.get(session_id) is not None:
            return  # the harness's session_ended, or our worker's exit, drains it later
        for feedback in self.store.list_feedback(session_id=session_id, status="queued"):
            if feedback.id not in self._waiting:
                self._learn(session, feedback)
                return

    def _learn(self, session: Session, feedback: Feedback) -> None:
        if not self._reserve(session.id):
            return
        feedback = self.store.set_feedback_status(feedback.id, "learning")
        handlers: FeedbackHandlers | None = None
        try:
            job, handlers = self._backward_job(session, feedback)
            self._started(session.id, self.registry.spawn(job, self._run_dir(session.id), handlers))
        except Exception as exc:
            log.exception("can't start learning from feedback %s", feedback.id)
            self._learned(feedback.id, handlers, {"type": "error", "message": str(exc)})

    def _learned(self, feedback_id: str, handlers: FeedbackHandlers | None, outcome: dict[str, Any] | None) -> None:
        feedback = self.store.get_feedback(feedback_id)
        self._release(feedback.session_id)
        commit = handlers.committed() if handlers is not None else None
        status = next_status(outcome, committed=commit is not None, attempts=feedback.attempts)
        if status == "applied":
            # Feedback the learner already reflected commits nothing; it stands at the current commit.
            self.store.set_feedback_status(feedback_id, "applied", commit=commit or self.git.head())
        elif status == "learning_failed":
            log.warning("learning from feedback %s failed: %s", feedback_id, outcome)
            self.store.set_feedback_status(feedback_id, "learning_failed")
        else:
            self.store.set_feedback_status(feedback_id, "queued")
            if status == "retry_later":
                self._waiting.add(feedback_id)
        self._drain(feedback.session_id)

    # --- jobs ------------------------------------------------------------------------

    def _debrief_job(self, session: Session, run_id: str, *, kind: str,
                     feedback: str | None = None) -> tuple[Job, dict[str, Any]]:
        pin = self.git.pin(session.repo_commit)
        defaults = self._defaults(load_repo(pin))
        provider = self.harness.provider()
        memory = {"profile": ProfileMemorySpec(store="profile", max_chars=defaults.profile_max_chars,
                                               llm_config=provider.llm_config)}
        transcript = transcript_text(self.store.list_messages(session.id)) if kind == "chat" else ""
        job = Job(kind=kind, session_id=session.id, run_id=run_id, person_id=session.person, pin=str(pin),
                  flow=DEBRIEF_FLOW, log=self._log(session.id, run_id), inputs={"transcript": transcript},
                  llm_config=provider.llm_config, learnable=True, memory=memory, env=provider.env, feedback=feedback)
        return job, {"profile": GitProfileStore(self.git, session.person)}

    def _backward_job(self, session: Session, feedback: Feedback) -> tuple[Job, FeedbackHandlers]:
        """The backward job for ``feedback``: the run's own flow, tools, and memory, from its pinned commit."""
        record = self.store.get_debrief_record(session.id)
        exited: Callable[[dict[str, Any] | None], None] = lambda outcome: self._post(  # noqa: E731
            self._learned, feedback.id, handlers, outcome)
        source = f"from feedback on run {feedback.run_id} ({self.git.handle(f'people/{feedback.author}/profile.md')})"
        if record is not None and record.run_id == feedback.run_id:
            job, stores = self._debrief_job(session, feedback.run_id, kind="backward", feedback=feedback.text)
            handlers = FeedbackHandlers(stores=stores, source=source, exited=exited)
            return job, handlers
        spec = self.harness.restorers[session.kind](session)
        provider = self.harness.provider()
        tools = spec.groups(session, feedback.run_id, _no_questions)
        memory = {name: m.model_copy(update={"llm_config": provider.llm_config})
                  if m.kind == "profile" and m.llm_config is None else m for name, m in spec.memory.items()}
        job = Job(kind="backward", session_id=session.id, run_id=feedback.run_id, person_id=session.person,
                  pin=str(self.git.pin(session.repo_commit)), flow=spec.flow,
                  log=self._log(session.id, feedback.run_id), inputs=spec.inputs, llm_config=provider.llm_config,
                  learnable=spec.learnable, skills=spec.skills, groups=group_specs(tools), memory=memory,
                  env=provider.env, feedback=feedback.text)
        handlers = FeedbackHandlers(tools=tools, stores=spec.stores, source=source, exited=exited)
        return job, handlers

    # --- helpers ---------------------------------------------------------------------

    def _post(self, fn: Callable[..., Any], *args: Any) -> None:
        self._jobs.put((fn, args))

    def _run(self) -> None:
        while (job := self._jobs.get()) is not None:
            fn, args = job
            try:
                fn(*args)
            except Exception:
                log.exception("learning: %s failed", getattr(fn, "__name__", fn))

    def _schedule(self) -> None:
        if self.tick_seconds is None:
            return
        with self._lock:
            if self._stopping:
                return
            self._timer = threading.Timer(self.tick_seconds, self._tock)
            self._timer.daemon = True
            self._timer.start()

    def _tock(self) -> None:
        self.tick()
        self._schedule()

    def _reserve(self, session_id: str) -> bool:
        with self._lock:
            if self._stopping or session_id in self._active:
                return False
            self._active[session_id] = None
            return True

    def _started(self, session_id: str, worker: Worker) -> None:
        with self._lock:
            self._active[session_id] = worker

    def _release(self, session_id: str) -> None:
        with self._lock:
            self._active.pop(session_id, None)

    def _session(self, session_id: str) -> Session:
        session = self.store.get_session(session_id)
        if session is None:
            raise HarnessError(404, "not_found", f"no session {session_id}")
        return session

    def _owner(self) -> str:
        repo = load_repo(self.git.root)
        if repo.company is None:
            raise HarnessError(422, "no_company", "the company has no company.yaml")
        return repo.company.ceo

    @staticmethod
    def _defaults(repo: Any) -> CompanyDefaults:
        return (repo.company.defaults if repo.company else None) or CompanyDefaults()

    def _run_dir(self, session_id: str) -> Path:
        return self.office.paths.run_dir(session_id)

    def _log(self, session_id: str, run_id: str) -> str:
        return str(self._run_dir(session_id) / "runs" / f"{run_id}.jsonl")

    def _mark_finished(self, session_id: str, run_id: str) -> None:
        """Record that a run finished: only a finished run can take feedback (a killed one would re-run)."""
        marker = self._run_dir(session_id) / "runs" / f"{run_id}.finished"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()

    def _finished(self, session_id: str, run_id: str) -> bool:
        return (self._run_dir(session_id) / "runs" / f"{run_id}.finished").exists()


def _no_questions(question: Any, **_: Any) -> Any:
    raise RuntimeError("a backward run asks no questions")


class _StopLearningFirst:
    """The office's workers, stopping learning before them.

    ``Office.stop`` stops its workers before any ``on_stop`` callback. Stopping learning first
    keeps the debriefs that stop kills from counting as attempts.
    """

    def __init__(self, learning: Learning, workers: Any) -> None:
        self.learning, self.workers = learning, workers

    def close_all(self) -> None:
        """Stop learning, then every worker."""
        self.learning.stop()
        self.workers.close_all()


def register(office: Any) -> None:
    """Add learning to an office that runs the chat harness; an office without one gets nothing."""
    harness = office.extras.get("harness")
    if harness is None:
        return
    learning = Learning(office, harness)
    office.extras["learning"] = learning
    office.workers = _StopLearningFirst(learning, office.workers)
    office.on_start.append(lambda: asyncio.to_thread(learning.start))
    office.on_stop.append(lambda: asyncio.to_thread(learning.stop))  # usually a no-op: close_all stopped it

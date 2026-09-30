"""The composer harness: each session's live run, driven by the office's routes and store events."""

import logging
import os
import queue
import socket
import threading
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent_composer.memory.storage.markdown import MarkdownStore

from agent_corp.chat.cost import call_usd, cost_cap
from agent_corp.chat.hooks import Hooks
from agent_corp.chat.provider import Provider, ProviderError
from agent_corp.chat.transcript import Transcript
from agent_corp.chat.turns import MAIN_CHAT, ChatFlow, seconds
from agent_corp.company.loader import load_repo
from agent_corp.perm.monitor import Monitor
from agent_corp.profile import GitProfileStore
from agent_corp.protocol import now
from agent_corp.protocol.models import CompanyDefaults, Event, Question, Session, WorkItem
from agent_corp.questions.ask import Answers, OnQuestion, make_ask_user
from agent_corp.questions.format import INTERRUPTED
from agent_corp.sandbox.policy import SandboxPolicy, UnsafeWorkspace, check_workspace
from agent_corp.store import InvalidTransition, new_id
from agent_corp.tools.company import company_tools
from agent_corp.tools.workspace import WorkspaceTools, workspace_tool_functions
from agent_corp.worker import (BaseHandlers, Job, ProfileMemorySpec, SessionMemorySpec, Worker, WorkerRegistry,
                               group_specs, person_flow)
from agent_corp.worker.job import MemorySpec

log = logging.getLogger(__name__)

INTERRUPTED_CALL = "interrupted; outcome unknown"
"""What an office tool call in flight returns on Esc: it runs on, so its side effect may still happen."""
LIVE = ("starting", "idle", "busy", "ending")
"""Session statuses that have (or should have) a live run."""
_CAP_TITLE = "Raise the cost cap"
_ENDED = ("NodeSucceeded", "NodeSkipped", "NodeFailed")

Groups = Callable[[Session, str, OnQuestion], Mapping[str, Mapping[str, Any]]]
"""``(session, run_id, on_question) -> {group: {tool name: tool}}``: the office tools of one run."""


class HarnessError(Exception):
    """A request the harness refuses; routes answer it as an ``ApiError``."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


@dataclass
class RunSpec:
    """How to start (and restart) a session's runs.

    ``flow`` is relative to the session's pinned commit. ``chat`` names the turn and reply
    nodes of a conversation flow; without it the harness takes no turns or steers.
    """

    flow: str
    groups: Groups
    inputs: dict[str, Any] = field(default_factory=dict)
    chat: ChatFlow | None = None
    learnable: bool = False
    memory: dict[str, MemorySpec] = field(default_factory=dict)
    stores: dict[str, MarkdownStore] = field(default_factory=dict)
    skills: list[str] = field(default_factory=list)
    names: tuple[str, ...] = ()
    workspace: WorkspaceTools | None = None


@dataclass(eq=False)
class _Call:
    """An office tool call in flight; ``cancel`` answers it at once."""

    done: threading.Event = field(default_factory=threading.Event)
    result: Any = None
    error: BaseException | None = None
    cancelled: bool = False

    def cancel(self) -> None:
        self.cancelled = True
        self.done.set()


@dataclass(eq=False)
class _Live:
    """A session with a live run, as the harness tracks it."""

    session_id: str
    person_id: str
    run_id: str
    spec: RunSpec
    defaults: CompanyDefaults
    transcript: Transcript
    worker: Worker | None = None
    provider: Provider = field(default_factory=Provider)
    owner: str | None = None  # the pinned company's CEO, who answers for the person
    reply_node: str | None = None
    turn_node: str | None = None  # the open turn question's node id
    next_reply: str | None = None  # the reply the answered turn starts, until its NodeStarted arrives
    turn_q: str | None = None
    pending: list[str] = field(default_factory=list)
    ending: bool = False
    capped: bool = False
    exits: int = 0
    died_at: str | None = None
    outcome: dict[str, Any] | None = None
    timer: threading.Timer | None = None
    calls: set[_Call] = field(default_factory=set)


class _Handlers(BaseHandlers):
    """One worker's frames, routed to the harness."""

    def __init__(self, harness: "Harness", live: _Live, ask: Callable[..., Any],
                 tools: Mapping[str, Mapping[str, Any]]) -> None:
        super().__init__(tools=tools, stores=live.spec.stores)
        self.harness, self.live, self.ask = harness, live, ask

    def event(self, worker: Worker, frame: dict[str, Any]) -> None:
        if not self.harness._closed:
            self.harness._event(self.live, worker, frame["name"], frame["data"])

    def stream(self, worker: Worker, frame: dict[str, Any]) -> None:
        if self.live.worker is worker and not self.harness._closed:
            self.live.transcript.stream(frame)

    def steer_left(self, worker: Worker, node_id: str, texts: list[str]) -> None:
        self.harness._post(self.harness._steer_left, self.live, texts)

    def result(self, worker: Worker, frame: dict[str, Any]) -> None:
        self.live.outcome = frame

    def error(self, worker: Worker, frame: dict[str, Any]) -> None:
        self.live.outcome = frame

    def exited(self, worker: Worker, returncode: int) -> None:
        self.harness._post(self.harness._exited, self.live, worker, returncode)

    def ask_user(self, worker: Worker, request: dict[str, Any]) -> Any:
        with self.harness._in_call():
            return self.ask(**request)

    def tool_call(self, worker: Worker, group: str, name: str, args: dict[str, Any]) -> Any:
        with self.harness._in_call():
            if group == "workspace":  # Esc kills a workspace call itself
                return BaseHandlers.tool_call(self, worker, group, name, args)
            return self.harness._cancellable(self.live,
                                             lambda: BaseHandlers.tool_call(self, worker, group, name, args))


class Harness:
    """Run each session as one live composer run in a worker, and drive it.

    ``prompt``, ``steer``, ``interrupt``, ``end``, ``answer``, and ``set_cost_cap`` are
    called from request threads. Worker frames and store events are handled on one
    dispatcher thread, in order. ``provider`` is read at each spawn.
    """

    def __init__(self, office: Any, monitor: Monitor, *, provider: Callable[[], Provider] = Provider) -> None:
        self.office = office
        self.store = office.store
        self.git = office.git
        self.monitor = monitor
        self.provider = provider
        self.hooks = Hooks()
        self.registry = WorkerRegistry(self.store)
        self.answers = Answers(self.store)
        self.restorers: dict[str, Callable[[Session], RunSpec]] = {"main": self.main_spec}
        self._lock = threading.RLock()
        self._live: dict[str, _Live] = {}
        self._stopping = False  # set when close_all starts: no new worker spawns
        self._refusing = False  # set once the channels are closed: no new worker request is admitted
        self._closed = False  # set when close_all returns: the caller may close the store
        self._calls = 0
        self._calls_idle = threading.Condition()
        self._jobs: queue.Queue[tuple[Callable[..., Any], tuple[Any, ...]] | None] = queue.Queue()
        self._thread = threading.Thread(target=self._dispatch, name="harness", daemon=True)
        self._thread.start()
        self._unlisten = self.store.add_listener(self._stored)

    # --- starting ---------------------------------------------------------------------

    def start_session(self, person_id: str, cwd: str, harness: str = "composer") -> Session:
        """Start a person's main chat in ``cwd``: work item, session, worked folder, then its run.

        A run that can't start leaves the session ``failed`` and raises ``500 start_failed`` naming it.
        """
        if harness != "composer":
            raise HarnessError(422, "unsupported_harness", f"the {harness} harness is not supported yet")
        self.git.commit_hand_edits()
        head = self.git.head()
        repo = load_repo(self.git.pin(head))
        person = repo.people.get(person_id)
        if person is None:
            raise HarnessError(404, "not_found", f"no person {person_id}")
        if person.kind != "agent" or not person.main:
            raise HarnessError(422, "not_an_agent", f"{person_id} has no main flow to chat with")
        if person.harnesses and "composer" not in person.harnesses:
            raise HarnessError(422, "unsupported_harness", f"{person_id} doesn't use the composer harness")
        if not Path(cwd).is_absolute():
            raise HarnessError(422, "invalid_body", f"cwd {cwd!r} is not an absolute path")
        cwd = os.path.realpath(cwd)  # clients match folders by their resolved path (/tmp is /private/tmp on macOS)
        session_id = new_id()
        self._policy(person_id, person.harness_policy, cwd, session_id)  # refuse a bad folder before any write
        t = now()
        item = self.store.create_work_item(WorkItem(
            id=new_id(), title=f"Chat with {person.name} in {Path(cwd).name or cwd}", kind="task",
            status="in_progress", requester=repo.company.ceo if repo.company else person_id, assignee=person_id,
            created_at=t, updated_at=t))
        session = self.store.create_session(Session(
            id=session_id, person=person_id, harness="composer", office=socket.gethostname(), cwd=cwd,
            repo_commit=head, status="starting", kind="main", work_item_id=item.id, created_at=t, updated_at=t))
        self.store.touch_worked_folder(person_id, cwd)
        try:
            spec = self.main_spec(session)
            self.start_run(session, spec)
        except Exception as exc:
            # start_run fails the session itself; a spec that couldn't be built leaves it starting.
            if session_id not in self._live and self.store.get_session(session_id).status == "starting":
                if not isinstance(exc, HarnessError):
                    log.exception("can't build the run spec for session %s", session_id)
                self._fail(session_id)
            if isinstance(exc, HarnessError):
                raise
            # The client needs the failed session's id. A provider error never echoes the file;
            # anything else may hold anything, so it stays in the log.
            why = f": {exc}" if isinstance(exc, ProviderError) else "; see the office log"
            raise HarnessError(500, "start_failed", f"session {session_id} failed to start{why}") from exc
        return self.store.get_session(session_id)

    def main_spec(self, session: Session) -> RunSpec:
        """The run spec of a person's main chat: the chat flow, profile and session memory, and every tool group."""
        pin = self.git.pin(session.repo_commit)
        repo = load_repo(pin)
        person = repo.people[session.person]
        defaults = _defaults(repo)
        workspace = WorkspaceTools(self._policy(person.id, person.harness_policy, session.cwd, session.id))

        def groups(s: Session, run_id: str, on_question: OnQuestion) -> dict[str, dict[str, Any]]:
            return {
                "toolbox": dict(self.monitor.tools(person.id, run_id=run_id, session_id=s.id)),
                "workspace": workspace_tool_functions(self.monitor.workspace(workspace, person.id, run_id,
                                                                             session_id=s.id)),
                "company": company_tools(self.store, repo, s, run_id, on_question, carried=self.answers.carried),
            }

        return RunSpec(
            flow=person_flow(person.id, person.main), groups=groups, chat=MAIN_CHAT, learnable=True,
            memory={"profile": ProfileMemorySpec(store="profile", max_chars=defaults.profile_max_chars),
                    "session": SessionMemorySpec(storage=str(self._run_dir(session.id) / "memory.sqlite"))},
            stores={"profile": GitProfileStore(self.git, person.id)}, skills=list(person.skills),
            names=(person.id, person.handle, person.name), workspace=workspace)

    def start_run(self, session: Session, spec: RunSpec) -> str:
        """Start a new run of ``spec`` for ``session`` (a stored session with no live run); return its run id.

        If the run can't start, the session is ``failed`` and has no live run.
        """
        with self._lock:
            if session.id in self._live:
                raise HarnessError(409, "live", f"session {session.id} already has a live run")
        try:
            run_id = new_id()
            self.store.add_session_run(session.id, run_id)
            live = self._new_live(session, run_id, spec)
        except Exception:
            log.exception("can't start a run for session %s", session.id)
            self._fail(session.id)
            raise
        with self._lock:
            if session.id in self._live:
                raise HarnessError(409, "live", f"session {session.id} already has a live run")
            self._live[session.id] = live
        self._spawn(live, "chat")  # on failure, it fails the session and drops the live entry
        return run_id

    def _new_live(self, session: Session, run_id: str, spec: RunSpec) -> _Live:
        repo = load_repo(self.git.pin(session.repo_commit))
        return _Live(session.id, session.person, run_id, spec, _defaults(repo),
                     Transcript(self.store, session.id, self.office.bus.publish_live), owner=_ceo(repo))

    def restore(self) -> None:
        """Resume every session that was live when the office stopped, under the same run id."""
        for session in self.store.list_sessions(status=LIVE, limit=None):
            if session.harness != "composer" or session.id in self._live:
                continue
            # One session that can't resume must not stop the others, or the office's start.
            live = None
            try:
                self._interrupt_running_tools(session.id)
                if session.run_ids:  # else the office stopped before its first run was recorded
                    live = self._new_live(session, session.run_ids[-1], self.restorers[session.kind](session))
            except Exception:
                log.exception("can't resume session %s", session.id)
            if live is None:
                self._fail(session.id)
                continue
            live.ending = session.status == "ending"
            with self._lock:
                self._live[session.id] = live
            try:
                self._spawn(live, "resume")
            except Exception:
                pass  # _spawn logged it and failed the session

    def _interrupt_running_tools(self, session_id: str) -> None:
        """Mark tool parts a dead office left ``running`` as interrupted; their calls died with it."""
        for message in self.store.list_messages(session_id):
            for part in message.parts:
                if part.type == "tool" and part.state == "running":
                    self.store.put_part(message.id, part.model_copy(update={"state": "interrupted"}))

    def _spawn(self, live: _Live, kind: str) -> None:
        """Start ``live``'s worker; if anything fails, fail the session (dropping it from the live ones) and raise."""
        try:
            if kind == "resume":
                # The agent node that asked re-runs and asks afresh.
                for q in self.store.list_questions(run_id=live.run_id, status="open"):
                    if q.node_id is None:
                        self.store.set_question_status(q.id, "stale")
            session = self.store.get_session(live.session_id)
            live.provider = provider = self.provider()
            on_question = self._on_question(live)
            tools = live.spec.groups(session, live.run_id, on_question)
            ask = make_ask_user(session, live.run_id, on_question, names=live.spec.names,
                                carried=self.answers.carried)
            memory = {name: m.model_copy(update={"llm_config": provider.llm_config})
                      if m.kind == "profile" and m.llm_config is None else m for name, m in live.spec.memory.items()}
            run_dir = self._run_dir(live.session_id)
            job = Job(kind=kind, session_id=live.session_id, run_id=live.run_id, person_id=live.person_id,
                      pin=str(self.git.pin(session.repo_commit)), flow=live.spec.flow,
                      log=str(run_dir / "runs" / f"{live.run_id}.jsonl"), inputs=live.spec.inputs,
                      llm_config=provider.llm_config, learnable=live.spec.learnable, skills=live.spec.skills,
                      groups=group_specs(tools), memory=memory, env=provider.env)
            # Under the lock, so a steer or close_all never meets a worker that is still starting.
            with self._lock:
                if self._stopping:
                    return
                live.worker = self.registry.spawn(job, run_dir, _Handlers(self, live, ask, tools))
        except Exception:
            log.exception("can't start a worker for session %s", live.session_id)
            self._finish(live, "failed", None)
            raise
        self._post(self.hooks.fire, "run_started", session, live.run_id)

    # --- the person's keys -------------------------------------------------------------

    def prompt(self, session_id: str, text: str) -> str:
        """Take a message: a new turn, an answer to the model's open question, a steer, or queued.

        Returns which one: ``turn``, ``answer``, ``steer``, or ``queued`` (the next turn
        takes it; so do messages while the session is over its cost cap).
        """
        with self._lock:
            live = self._must(session_id)
            if live.ending:
                raise HarnessError(409, "ending", f"session {session_id} is ending")
            self._check_prompt(live, text)
            if live.spec.chat is not None and not self._held(live):
                if live.turn_q is not None:
                    live.transcript.user(text)
                    self._answer_turn(live, live.turn_q, text)
                    return "turn"
                asked = self.store.list_questions(run_id=live.run_id, status="open", source="ask_user")
                if asked:
                    try:
                        self.store.answer_question(asked[0].id, text, "text", answered_by=live.owner)
                        return "answer"
                    except InvalidTransition:
                        pass  # a card answered it first (cards don't take this lock); the text is the next message
            live.transcript.user(text)
            if live.reply_node is not None and live.worker is not None and live.worker.steer(live.reply_node, text):
                return "steer"
            self._queue(live, [text])
            return "queued"

    def steer(self, session_id: str, text: str) -> str:
        """Steer the running reply; a message with no reply running is a ``prompt``."""
        with self._lock:
            live = self._must(session_id)
            if live.reply_node is not None and live.worker is not None and not live.ending:
                self._check_prompt(live, text)
                live.transcript.user(text)
                if live.worker.steer(live.reply_node, text):
                    return "steer"
                live.pending.append(text)
                return "queued"
        return self.prompt(session_id, text)

    def interrupt(self, session_id: str) -> None:
        """Esc: answer the model's open questions, kill workspace calls, answer office calls, stop the reply."""
        with self._lock:
            live = self._must(session_id)
            for q in self.store.list_questions(run_id=live.run_id, status="open", source="ask_user"):
                try:
                    self.store.answer_question(q.id, INTERRUPTED, "interrupted")
                except InvalidTransition:
                    pass  # answered meanwhile
            if live.spec.workspace is not None:
                live.spec.workspace.interrupt()
            for call in list(live.calls):
                call.cancel()
            node, worker = live.reply_node or live.next_reply, live.worker
        if node is not None and worker is not None:
            worker.interrupt(node)

    def end(self, session_id: str) -> None:
        """End the session through the flow's exit, interrupting a busy reply first."""
        with self._lock:
            live = self._must(session_id)
            if live.ending:
                return
            live.ending = True
            live.pending.clear()
            self.store.update_session(session_id, status="ending")
            turn = live.turn_q
            if turn is not None and live.spec.chat is not None:
                self._answer_turn(live, turn, live.spec.chat.exit, by=None)
                return
        self.interrupt(session_id)  # the next turn question is answered with the exit command

    def answer(self, question_id: str, answer: Any, kind: str) -> Question:
        """Answer a question for the person, after the ``answer_check`` hooks; a chat turn goes through ``prompt``."""
        question = self.store.get_question(question_id)
        if question is None:
            raise HarnessError(404, "not_found", f"no question {question_id}")
        if question.status != "open":
            raise HarnessError(409, "not_open", f"question {question_id} is {question.status}")
        for refusal in self.hooks.fire("answer_check", question, answer, kind):
            if refusal:
                raise HarnessError(422, "invalid_answer", str(refusal))
        live = self._live.get(question.session_id)
        if live is not None and live.run_id == question.run_id and live.spec.chat is not None \
                and live.spec.chat.is_turn(question.node_id):
            if not isinstance(answer, str) or not answer:
                raise HarnessError(422, "invalid_answer", "a chat turn takes text")
            with self._lock:
                if live.turn_q != question_id or self._held(live):
                    raise HarnessError(409, "not_open", f"question {question_id} can't take a turn now")
                self._check_prompt(live, answer)
                live.transcript.user(answer)
                self._answer_turn(live, question_id, answer)
            return self.store.get_question(question_id)
        try:
            return self.store.answer_question(question_id, answer, kind, answered_by=self._owner(question, live))
        except InvalidTransition as exc:
            raise HarnessError(409, "not_open", str(exc)) from exc

    def set_cost_cap(self, session_id: str, usd: float) -> Session:
        """Set the session's cost cap; it must be above the cost so far. Held turns go on."""
        session = self.store.get_session(session_id)
        if session is None:
            raise HarnessError(404, "not_found", f"no session {session_id}")
        if usd <= session.cost:
            raise HarnessError(422, "cap_too_low", f"the cap must be above the cost so far (${session.cost:.4f})")
        item = self._cap_item(session)
        session = self.store.update_session(session_id, cost_cap_usd=usd)
        if item is not None:
            self.store.update_work_item(item.id, status="done")
        with self._lock:
            live = self._live.get(session_id)
            if live is not None:
                live.capped = False
                self._deliver(live)
        return session

    def close_all(self) -> None:
        """Stop every worker, leaving their sessions to ``restore``, and stop the dispatcher.

        No new worker spawns from the start. Once the workers' channels are closed, no new
        worker request is admitted, workspace calls are killed, and office calls are
        answered; a request arriving before then still runs, so a worker is never told its
        ``ask_user`` failed because the office is stopping. Waits up to 10 seconds for worker
        requests still running to finish. Once it returns, the caller may close the store: worker frames, dispatcher
        jobs, and worker exits that come later no longer touch it.
        """
        with self._lock:
            if self._stopping:
                return
            self._stopping = True
            for live in self._live.values():
                if live.timer is not None:
                    live.timer.cancel()
        self.registry.close_all()
        with self._lock:
            with self._calls_idle:
                self._refusing = True
            for live in self._live.values():
                if live.spec.workspace is not None:
                    live.spec.workspace.interrupt()
                for call in list(live.calls):
                    call.cancel()
        for live in list(self._live.values()):
            live.transcript.abort()
        self._jobs.put(None)
        self._thread.join(10)
        if self._thread.is_alive():
            log.warning("harness: the dispatcher is still busy at close")
        self._unlisten()
        self.answers.close()
        # Request threads outlive their workers; let them leave the store before the office closes it.
        with self._calls_idle:
            if not self._calls_idle.wait_for(lambda: self._calls == 0, timeout=10):
                log.warning("harness: %d tool or ask_user calls still running at close", self._calls)
            self._closed = True

    # --- turns ---------------------------------------------------------------------

    def _on_question(self, live: _Live) -> OnQuestion:
        def on_question(question: Question, *, work_item: WorkItem | None = None) -> Question:
            chat = live.spec.chat
            if chat is not None and chat.is_turn(question.node_id):
                # A turn re-shown after a restart reuses its stored question: no question.created.
                stored = self.store.get_question_by_node(question.run_id, question.node_id)
                if stored is not None and stored.status == "open":
                    self._post(self._turn_opened, live, stored.id)
            return self.answers.ask(question, work_item=work_item)

        return on_question

    def _stored(self, event: Event) -> None:
        # A store listener must not block: hand question changes to the dispatcher.
        if event.type in ("question.created", "question.updated"):
            self._post(self._question_changed, Question.model_validate(event.data), event.type)

    def _question_changed(self, question: Question, type_: str) -> None:
        if type_ == "question.created":
            self.hooks.fire("question_stored", question)
        live = self._live.get(question.session_id)
        if live is None or live.run_id != question.run_id or live.spec.chat is None \
                or not live.spec.chat.is_turn(question.node_id):
            return
        if question.status == "open":
            self._turn_opened(live, question.id)
        elif question.status == "answered":
            with self._lock:
                if self._current(live):
                    exiting = live.ending or question.answer == live.spec.chat.exit
                    self.store.update_session(live.session_id, status="ending" if exiting else "busy")

    def _turn_opened(self, live: _Live, question_id: str) -> None:
        with self._lock:
            if not self._current(live) or live.turn_q == question_id:
                return
            question = self.store.get_question(question_id)
            if question.status != "open":
                return
            live.turn_q, live.turn_node, live.next_reply = question_id, question.node_id, None
            if question_id != live.died_at:
                live.exits = 0  # a new turn: the resumed worker got somewhere
            chat = live.spec.chat
            self.store.update_session(live.session_id, status="ending" if live.ending else "idle")
            if live.ending or self._turns(live) >= live.defaults.max_turns:
                live.ending = True
                self._answer_turn(live, question_id, chat.exit, by=None)
                return
            if not self._deliver(live) and not live.pending:  # a held message isn't idleness
                live.timer = threading.Timer(seconds(live.defaults.idle_end), self._post,
                                             (self._idle, live, question_id))
                live.timer.daemon = True
                live.timer.start()

    def _queue(self, live: _Live, texts: list[str]) -> None:
        """Queue messages for the next turn; a queued message stops the idle timer."""
        live.pending.extend(texts)
        if live.timer is not None:
            live.timer.cancel()
            live.timer = None
        self._deliver(live)

    def _deliver(self, live: _Live) -> bool:
        """Answer the open turn with the queued messages, unless held; True if it did."""
        if live.turn_q is None or not live.pending or live.ending or self._held(live):
            return False
        self._answer_turn(live, live.turn_q, "\n\n".join(live.pending))
        live.pending.clear()
        return True

    def _answer_turn(self, live: _Live, question_id: str, text: str, *, by: str | None | bool = True) -> None:
        """Answer the turn; if the store refuses, the turn stays open for the next try."""
        # The person's message goes through turn_text; the exit command, typed or the office's, doesn't.
        answer = self._turn_text(live, question_id, text) if by is True and text != live.spec.chat.exit else text
        try:
            self.store.answer_question(question_id, answer, "text", answered_by=live.owner if by is True else by)
            if live.turn_node is not None and text != live.spec.chat.exit:
                live.next_reply = live.spec.chat.reply_after(live.turn_node)
        except InvalidTransition:
            log.warning("turn question %s was answered elsewhere", question_id)
        live.turn_q = None
        if live.timer is not None:
            live.timer.cancel()
            live.timer = None

    def _check_prompt(self, live: _Live, text: str) -> None:
        """Raise ``422 refused`` if a ``prompt_check`` hook refuses the person's ``text``."""
        session = self.store.get_session(live.session_id)
        for refusal in self.hooks.fire("prompt_check", session, text):
            if refusal:
                raise HarnessError(422, "refused", str(refusal))

    def _turn_text(self, live: _Live, question_id: str, text: str) -> str:
        """What the turn question gets for the person's ``text``: the first ``str`` from ``turn_text``, else ``text``."""
        session, question = self.store.get_session(live.session_id), self.store.get_question(question_id)
        return next((t for t in self.hooks.fire("turn_text", session, question, text) if isinstance(t, str)), text)

    def _turns(self, live: _Live) -> int:
        chat = live.spec.chat
        return sum(1 for q in self.store.list_questions(session_id=live.session_id, source="human_input",
                                                        status=("answered", "consumed"))
                   if chat.is_turn(q.node_id) and q.answer != chat.exit)

    def _idle(self, live: _Live, question_id: str) -> None:
        if self._current(live) and live.turn_q == question_id:
            self.end(live.session_id)

    def _steer_left(self, live: _Live, texts: list[str]) -> None:
        with self._lock:
            if self._current(live) and not live.ending:
                self._queue(live, texts)  # already in the transcript

    # --- worker frames ---------------------------------------------------------------

    def _event(self, live: _Live, worker: Worker, name: str, data: dict[str, Any]) -> None:
        if live.worker is not worker:
            return
        chat = live.spec.chat
        if chat is not None:
            node_id = data.get("node_id") or (data.get("failure") or {}).get("node_id")
            if name == "NodeStarted" and chat.is_reply(node_id):
                live.reply_node, live.next_reply = node_id, None
            elif name in _ENDED and node_id is not None and node_id == live.reply_node:
                live.reply_node = None
        live.transcript.event(name, data)
        if name == "ModelCallFinished" and data.get("usage"):
            self._charge(live, data)

    def _charge(self, live: _Live, data: dict[str, Any]) -> None:
        usage = data["usage"]
        self.store.record_usage(session_id=live.session_id, run_id=live.run_id, model=data.get("model") or "",
                                input_tokens=usage["input_tokens"], output_tokens=usage["output_tokens"],
                                usd=call_usd(live.provider.prices, data.get("model"), usage))
        session = self.store.update_session(live.session_id, cost=self.store.session_usage_usd(live.session_id))
        if session.cost >= cost_cap(session, live.defaults) and not live.capped:
            live.capped = True
            self._post(self._over_cap, live)  # interrupt() must not run on the reader thread

    def _over_cap(self, live: _Live) -> None:
        if not self._current(live):
            return
        self.interrupt(live.session_id)
        session = self.store.get_session(live.session_id)
        if self._cap_item(session) is not None:
            return  # the manager already has one to act on
        repo = load_repo(self.git.pin(session.repo_commit))
        person = repo.people.get(live.person_id)
        manager = (person.manager if person else None) or (repo.company.ceo if repo.company else None)
        cap = cost_cap(session, live.defaults)
        t = now()
        self.store.create_work_item(WorkItem(
            id=new_id(), title=f"{_CAP_TITLE} of @{person.handle if person else live.person_id}'s session",
            kind="task", status="open", requester=live.person_id, assignee=manager, parent_id=session.work_item_id,
            summary=f"Session {session.id} reached its ${cap:.2f} cap (cost ${session.cost:.4f}). "
                    f"Its turns wait until the cap is raised.",
            created_at=t, updated_at=t))

    def _cap_item(self, session: Session) -> WorkItem | None:
        """The session's open "raise the cost cap" work item, if any."""
        # The summary names the session, so sessions with no work item don't share one.
        mine = f"Session {session.id} "
        return next((w for w in self.store.list_work_items(status=("open", "in_progress"))
                     if w.parent_id == session.work_item_id and w.title.startswith(_CAP_TITLE)
                     and (w.summary or "").startswith(mine)), None)

    def _exited(self, live: _Live, worker: Worker, returncode: int) -> None:
        if self._closed:
            return
        session = self.store.get_session(live.session_id)
        self.hooks.fire("worker_exited", session, returncode)
        with self._lock:
            if live.worker is not worker or self._stopping:
                return
            live.died_at = live.turn_q
            live.worker, live.reply_node, live.next_reply, live.turn_q = None, None, None, None
            if live.timer is not None:
                live.timer.cancel()
            outcome, live.outcome = live.outcome, None
            if live.spec.workspace is not None:
                live.spec.workspace.interrupt()  # nobody is left to read what its calls return
            for call in list(live.calls):
                call.cancel()
        live.transcript.abort()
        if outcome is None:
            if live.exits >= 1:  # died again before a new turn: a third try won't do better
                self._finish(live, "failed", None)
            else:
                live.exits += 1
                self._spawn(live, "resume")
            return
        live.exits = 0
        failure = outcome.get("failure") or {}
        if outcome["type"] == "result" and (outcome["status"] == "succeeded"
                                            or failure.get("cause_type") == "LoopMaxExceeded"):
            self._finish(live, "ended", outcome)
        elif outcome["type"] == "result" and live.spec.chat is not None and self._asked_turn(live):
            self.hooks.fire("run_finished", session, live.run_id, _redact(outcome, live.provider))
            for q in self.store.list_questions(run_id=live.run_id, status="open"):
                self.store.set_question_status(q.id, "stale")
            live.run_id = new_id()
            self.store.add_session_run(live.session_id, live.run_id)
            self._spawn(live, "chat")
        else:
            self._finish(live, "failed", outcome)

    def _asked_turn(self, live: _Live) -> bool:
        return any(live.spec.chat.is_turn(q.node_id)
                   for q in self.store.list_questions(run_id=live.run_id, source="human_input"))

    def _finish(self, live: _Live, status: str, outcome: dict[str, Any] | None) -> None:
        with self._lock:
            if self._live.get(live.session_id) is live:
                del self._live[live.session_id]
        if status == "ended":
            session = self.store.get_session(live.session_id)
            status = next((s for s in self.hooks.fire("end_status", session) if s), "ended")
            # Close the item first, so no client sees an ended session with its work still open.
            if session.work_item_id:
                self.store.update_work_item(session.work_item_id, status="done")
        session = self.store.update_session(live.session_id, status=status)
        self.hooks.fire("run_finished", session, live.run_id, _redact(outcome, live.provider))
        self.hooks.fire("session_ended", session)

    def _fail(self, session_id: str) -> None:
        """Fail a session that has no live run."""
        self.hooks.fire("session_ended", self.store.update_session(session_id, status="failed"))

    # --- helpers ---------------------------------------------------------------------

    def _post(self, fn: Callable[..., Any], *args: Any) -> None:
        self._jobs.put((fn, args))

    def _dispatch(self) -> None:
        while (job := self._jobs.get()) is not None:
            if self._closed:
                continue  # the store may be closed: drain without running
            fn, args = job
            try:
                fn(*args)
            except Exception:
                log.exception("harness: %s failed", getattr(fn, "__name__", fn))

    def _cancellable(self, live: _Live, fn: Callable[[], Any]) -> Any:
        call = _Call()

        def run() -> None:
            try:
                with self._in_call():
                    call.result = fn()
            except BaseException as exc:
                call.error = exc
            finally:
                call.done.set()

        with self._lock:
            live.calls.add(call)
        threading.Thread(target=run, name=f"tool-{live.session_id}", daemon=True).start()
        try:
            call.done.wait()
        finally:
            with self._lock:
                live.calls.discard(call)
        if call.cancelled:
            return INTERRUPTED_CALL
        if call.error is not None:
            raise call.error
        return call.result

    @contextmanager
    def _in_call(self) -> Iterator[None]:
        """Count a worker request running in the office, for ``close_all`` to wait on; refuse one once the channels are closed."""
        with self._calls_idle:
            if self._refusing:
                raise RuntimeError("the office is stopping")
            self._calls += 1
        try:
            yield
        finally:
            with self._calls_idle:
                self._calls -= 1
                self._calls_idle.notify_all()

    def _current(self, live: _Live) -> bool:
        return self._live.get(live.session_id) is live

    def _must(self, session_id: str) -> _Live:
        live = self._live.get(session_id)
        if live is None:
            if self.store.get_session(session_id) is None:
                raise HarnessError(404, "not_found", f"no session {session_id}")
            raise HarnessError(409, "not_live", f"session {session_id} has no live run")
        return live

    def _held(self, live: _Live) -> bool:
        session = self.store.get_session(live.session_id)
        return session.cost >= cost_cap(session, live.defaults)

    def _owner(self, question: Question, live: _Live | None) -> str | None:
        if live is not None and live.session_id == question.session_id:
            return live.owner
        session = self.store.get_session(question.session_id) if question.session_id else None
        return _ceo(load_repo(self.git.pin(session.repo_commit))) if session is not None else None

    def _run_dir(self, session_id: str) -> Path:
        return self.office.paths.run_dir(session_id)

    def _policy(self, person_id: str, policy: Any, cwd: str, session_id: str) -> SandboxPolicy:
        """The sandbox for ``cwd``; a missing or unsafe folder is refused before the run's tmp is made."""
        if not Path(cwd).is_dir():
            raise HarnessError(422, "invalid_body", f"cwd {cwd!r} is not a folder")
        real = Path(os.path.realpath(cwd))
        try:
            check_workspace(real)
        except UnsafeWorkspace as exc:
            raise HarnessError(422, "unsafe_workspace", str(exc)) from exc
        # The sandbox guards ~/.agent-corp; this office's home may be elsewhere.
        for kept in (self.office.paths.company, self.office.paths.office):
            kept = Path(os.path.realpath(kept))
            if real.is_relative_to(kept) or kept.is_relative_to(real):
                raise HarnessError(422, "unsafe_workspace",
                                   f"workspace {real} overlaps the office's files at {kept}; use a project folder")
        tmp = self._run_dir(session_id) / "tmp"
        tmp.mkdir(parents=True, exist_ok=True)
        try:
            return SandboxPolicy(Path(cwd), writable=bool(policy and policy.sandbox == "workspace-write"),
                                 network=bool(policy and policy.network), tmpdir=tmp)
        except ValueError as exc:  # UnsafeWorkspace is a ValueError
            raise HarnessError(422, "unsafe_workspace", str(exc)) from exc


def _defaults(repo: Any) -> CompanyDefaults:
    return (repo.company.defaults if repo.company else None) or CompanyDefaults()


def _ceo(repo: Any) -> str | None:
    return repo.company.ceo if repo.company else None


def _redact(value: Any, provider: Provider) -> Any:
    """``value`` with the provider's model key replaced by ``[redacted]`` wherever it appears."""
    key = (provider.llm_config or {}).get("api_key")
    if not isinstance(key, str) or not key:
        return value

    def scrub(v: Any) -> Any:
        if isinstance(v, str):
            return v.replace(key, "[redacted]")
        if isinstance(v, dict):
            return {scrub(k): scrub(x) for k, x in v.items()}
        if isinstance(v, (list, tuple)):
            return [scrub(x) for x in v]
        return v

    return scrub(value)

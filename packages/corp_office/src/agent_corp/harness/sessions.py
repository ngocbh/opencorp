"""The office's live Codex sessions; ``Harness`` hands it every call on a session whose harness is ``codex``."""

import logging
import threading
from collections.abc import Callable
from typing import Any

from agent_corp.chat.harness import LIVE, HarnessError
from agent_corp.chat.hooks import Hooks
from agent_corp.chat.transcript import INTERRUPTED_TEXT
from agent_corp.chat.turns import seconds
from agent_corp.company.loader import load_repo
from agent_corp.harness.codex import CLOSE_GRACE, CodexProcess, CodexStartError, codex_command
from agent_corp.harness.session import CodexSession
from agent_corp.protocol.models import CompanyDefaults, HarnessPolicy, Message, Question, Session
from agent_corp.store import InvalidTransition
from agent_corp.worker.spawn import worker_env

log = logging.getLogger(__name__)


class CodexSessions:
    """Each live Codex session of the office, with its own app-server.

    ``hooks`` are ``Harness.hooks``: Codex sessions fire ``prompt_check``, ``end_status`` and ``session_ended`` (never
    the run hooks: Codex turns are not office runs). ``env`` gives an app-server's environment (``worker_env()``);
    ``command`` replaces the ``codex app-server`` command found on its PATH. Tests pass the fake's.
    """

    def __init__(self, office: Any, hooks: Hooks, *, command: Callable[[], list[str]] | None = None,
                 env: Callable[[], dict[str, str]] = worker_env, close_grace: float = CLOSE_GRACE) -> None:
        self.office, self.store, self.hooks = office, office.store, hooks
        self.command, self.env, self.close_grace = command, env, close_grace
        self._lock = threading.Lock()
        self._live: dict[str, CodexSession] = {}
        self._closed = False  # set by close_all: no session starts after office stop

    # --- calls from Harness ----------------------------------------------------------

    def start(self, session: Session, *, resume: bool = False) -> None:
        """Load ``session``'s thread in a new app-server on the session's own thread; a failure there fails the
        session. Raises only if the session can't be set up at all, before anything runs."""
        author = self.opener(session)
        with self._lock:
            if self._closed:  # the office is stopping: the session stays as it is, for restore
                return
            live = self._live[session.id] = CodexSession(self, session, author=author)
        live.start(resume=resume)

    def prompt(self, session_id: str, text: str, *, by: str | None = None) -> str:
        """A message: ``turn``, ``steer`` (a turn was running), or ``queued`` (until the thread is loaded)."""
        live = self._must(session_id)
        for refusal in self.hooks.fire("prompt_check", self.store.get_session(session_id), text):
            if refusal:
                raise HarnessError(422, "refused", str(refusal))
        return live.prompt(text, by=by)

    def interrupt(self, session_id: str) -> None:
        self._must(session_id).interrupt()

    def end(self, session_id: str) -> None:
        self._must(session_id).end()

    def answer(self, question_id: str, answer: Any, kind: str, *, by: str | None = None) -> Question:
        """Store the answer (secret pages as ``[secret]``), then reply if Codex still waits; the store's open →
        answered move picks the one answer that replies, and a second answer is 409 ``not_open``. An answer Codex no
        longer waits for, or that no reply can be made from, is returned with the card ``stale`` and no decision.
        ``by`` is the session's opener when None, as composer credits an answer."""
        question = self.store.get_question(question_id)
        live = self._live.get(question.session_id)
        by = by or (live.author if live else self.opener(self.store.get_session(question.session_id)))
        try:
            self.store.answer_question(question_id, _masked(question, answer), kind, answered_by=by)
        except InvalidTransition as exc:
            raise HarnessError(409, "not_open", str(exc)) from exc
        # The secret itself is only ever in this call's arguments, until the reply.
        if live is None or not live.reply(question_id, answer, by):
            self.store.lose_answer(question_id)
        return self.store.get_question(question_id)

    def close_all(self) -> None:
        """Office stop: kill every app-server and stop every session's thread; sessions keep their status for
        ``restore``. Once it returns, no Codex session touches the store."""
        with self._lock:
            self._closed = True
            live, self._live = list(self._live.values()), {}
        for session in live:
            session.shutdown()

    def restore(self) -> None:
        """After an office restart, for each Codex session that was live. Idle stays idle with no app-server (its
        next message reloads the thread). Busy becomes idle with ``[interrupted]``: Codex reports that turn
        interrupted on resume and never reruns it. Starting fails. Ending finishes ending. Open cards go stale."""
        for session in self.store.list_sessions(status=LIVE, limit=None):
            if self._closed:  # the office is stopping: what is left stays as it is, for the next restore
                return
            if session.harness != "codex" or session.id in self._live:
                continue
            try:  # one session that can't be restored mustn't stop the others, or the office
                self._restore(session)
            except Exception:
                log.exception("can't restore Codex session %s", session.id)

    def _restore(self, session: Session) -> None:
        for q in self.store.list_questions(session_id=session.id, status="open"):
            try:
                self.store.set_question_status(q.id, "stale")
            except InvalidTransition:
                pass  # answered meanwhile: no app-server waits on its answer
        for message in self.store.list_messages(session.id):  # their commands died with the app-server
            for part in message.parts:
                if part.type == "tool" and part.state == "running":
                    self.store.put_part(message.id, part.model_copy(update={"state": "interrupted"}))
        live = CodexSession(self, session, author=self.opener(session))
        with self._lock:
            if self._closed:  # office stop came meanwhile
                live.release()
                return
            self._live[session.id] = live
        if session.status == "starting" or not session.harness_session_id:
            live.transcript.error("The office restarted before Codex started. Start a new chat.")
            live.release()
            self.finished(live, "failed")
        elif session.status == "ending":
            live.release()
            self.finished(live, "ended")
        else:
            if session.status == "busy" and not _ends_interrupted(self.store.list_messages(session.id)):
                live.translator.turn_completed("restored", "interrupted", None)  # unless office stop stored it
            live.idle_after_restore(session.status)

    # --- calls from CodexSession -----------------------------------------------------

    def launch(self, live: CodexSession) -> CodexProcess:
        """A started, initialized app-server for ``live``, in its cwd, with the worker environment."""
        env = self.env()
        # Each callback says which app-server it came from, so the session drops what an earlier one still sends.
        process = CodexProcess(self.store, f"harness:{live.session_id}",
                               command=self.command() if self.command else codex_command(env), cwd=live.cwd, env=env,
                               log=self.office.paths.run_dir(live.session_id) / "codex.log",
                               on_notification=lambda method, params: live.notified(process, method, params),
                               on_request=lambda request_id, method, params: live.requested(process, request_id,
                                                                                            method, params),
                               on_exit=live.exited)
        if not live.launching_as(process):  # before it spawns, so office stop can kill it mid-handshake
            raise CodexStartError("The office is stopping.")
        process.start()
        return process

    def finished(self, live: CodexSession, status: str) -> None:
        """Drop ``live`` and end its session: ``ended`` (or the first ``end_status``, such as ``debriefing``) or
        ``failed``. ``session_ended`` fires once."""
        with self._lock:
            if self._live.get(live.session_id) is live:
                del self._live[live.session_id]
        session = self.store.get_session(live.session_id)
        if status == "ended":
            status = next((s for s in self.hooks.fire("end_status", session) if s), "ended")
            if session.work_item_id:  # first, so no client sees an ended session with its work still open
                self.store.update_work_item(session.work_item_id, status="done")
        self.hooks.fire("session_ended", self.store.update_session(live.session_id, status=status))

    def policy(self, session_id: str) -> HarnessPolicy | None:
        """The session's person's harness policy at the session's pinned commit."""
        session = self.store.get_session(session_id)
        person = load_repo(self.office.git.pin(session.repo_commit)).people.get(session.person)
        return person.harness_policy if person else None

    def idle_seconds(self, session_id: str) -> int:
        """How long the session may sit idle before it ends: ``idle_end`` of its pinned company."""
        session = self.store.get_session(session_id)
        repo = load_repo(self.office.git.pin(session.repo_commit))
        return seconds(((repo.company.defaults if repo.company else None) or CompanyDefaults()).idle_end)

    def opener(self, session: Session) -> str | None:
        """Who a message with no named sender is from: the session's opener, else the pinned company's CEO."""
        if session.opened_by:
            return session.opened_by
        repo = load_repo(self.office.git.pin(session.repo_commit))
        return repo.company.ceo if repo.company else None

    def _must(self, session_id: str) -> CodexSession:
        live = self._live.get(session_id)
        if live is None:
            if self.store.get_session(session_id) is None:
                raise HarnessError(404, "not_found", f"no session {session_id}")
            raise HarnessError(409, "not_live", f"session {session_id} has no live Codex app-server")
        return live


def _ends_interrupted(messages: list[Message]) -> bool:
    """Whether the newest message is an assistant one whose last part already ends with the marker."""
    last = messages[-1] if messages else None
    tail = last.parts[-1] if last is not None and last.role == "assistant" and last.parts else None
    # A marker with nothing before it is stored without the leading blank line.
    return tail is not None and tail.type == "text" and tail.text.endswith(INTERRUPTED_TEXT.lstrip())


def _masked(question: Question, answer: Any) -> Any:
    """``answer`` as stored: on a card with a secret page, only the values of its other pages are kept, and anything
    else (a secret page's value, an unknown key, an answer that isn't a record) is ``[secret]``."""
    pages = question.questions or []
    if not any(p.secret for p in pages):
        return answer
    if not isinstance(answer, dict):
        return "[secret]"
    safe = {p.header for p in pages if not p.secret}
    return {k: v if k in safe else "[secret]" for k, v in answer.items()}

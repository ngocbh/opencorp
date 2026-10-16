"""The office's live Codex sessions; ``Harness`` hands it every call on a session whose harness is ``codex``."""

import logging
import threading
from collections.abc import Callable
from typing import Any

from agent_corp.chat.harness import HarnessError
from agent_corp.chat.hooks import Hooks
from agent_corp.chat.turns import seconds
from agent_corp.company.loader import load_repo
from agent_corp.harness.codex import CLOSE_GRACE, CodexProcess, CodexStartError, codex_command
from agent_corp.harness.session import CodexSession
from agent_corp.protocol.models import CompanyDefaults, HarnessPolicy, Session
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
        session = self.store.get_session(session_id)
        for refusal in self.hooks.fire("prompt_check", session, text):
            if refusal:
                raise HarnessError(422, "refused", str(refusal))
        return self._must(session_id).prompt(text, by=by)

    def interrupt(self, session_id: str) -> None:
        self._must(session_id).interrupt()

    def end(self, session_id: str) -> None:
        self._must(session_id).end()

    def close_all(self) -> None:
        """Office stop: kill every app-server and stop every session's thread; sessions keep their status for
        ``restore``. Once it returns, no Codex session touches the store."""
        with self._lock:
            self._closed = True
            live, self._live = list(self._live.values()), {}
        for session in live:
            session.shutdown()

    # --- calls from CodexSession -----------------------------------------------------

    def launch(self, live: CodexSession) -> CodexProcess:
        """A started, initialized app-server for ``live``, in its cwd, with the worker environment."""
        env = self.env()
        process = CodexProcess(self.store, f"harness:{live.session_id}",
                               command=self.command() if self.command else codex_command(env), cwd=live.cwd, env=env,
                               log=self.office.paths.run_dir(live.session_id) / "codex.log",
                               on_notification=live.notified, on_request=live.requested, on_exit=live.exited)
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

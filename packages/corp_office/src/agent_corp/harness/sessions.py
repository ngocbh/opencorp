"""The office's live Codex sessions; ``Harness`` hands it every call on a session whose harness is ``codex``."""

import logging
import threading
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from agent_corp.chat.hooks import Hooks
from agent_corp.company.loader import load_repo
from agent_corp.harness.codex import CLOSE_GRACE, CodexProcess, CodexStartError, codex_command
from agent_corp.protocol.models import HarnessPolicy, Session
from agent_corp.worker.spawn import worker_env

if TYPE_CHECKING:
    from agent_corp.harness.session import CodexSession

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

    # --- calls from Harness ----------------------------------------------------------

    def close_all(self) -> None:
        """Office stop: kill every app-server and stop every session's thread; sessions keep their status for
        ``restore``. Once it returns, no Codex session touches the store."""
        with self._lock:
            live, self._live = list(self._live.values()), {}
        for session in live:
            session.shutdown()

    # --- calls from CodexSession -----------------------------------------------------

    def launch(self, live: "CodexSession") -> CodexProcess:
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

    def policy(self, session_id: str) -> HarnessPolicy | None:
        """The session's person's harness policy at the session's pinned commit."""
        session = self.store.get_session(session_id)
        person = load_repo(self.office.git.pin(session.repo_commit)).people.get(session.person)
        return person.harness_policy if person else None

    def opener(self, session: Session) -> str | None:
        """Who a message with no named sender is from: the session's opener, else the pinned company's CEO."""
        if session.opened_by:
            return session.opened_by
        repo = load_repo(self.office.git.pin(session.repo_commit))
        return repo.company.ceo if repo.company else None

"""One Codex session the owner drives: its app-server, its thread, its transcript and its turns."""

import logging
import queue
import threading
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from agent_corp.chat.transcript import Transcript
from agent_corp.harness.codex import CodexProcess, owner_load
from agent_corp.harness.translate import Translator
from agent_corp.protocol.models import Session

if TYPE_CHECKING:
    from agent_corp.harness.sessions import CodexSessions

log = logging.getLogger(__name__)


class CodexSession:
    """One Codex session's app-server, thread, transcript and turns.

    Request threads call ``prompt``, ``interrupt``, ``end`` and ``shutdown``; loads, app-server messages and process
    exits run on the session's own thread, in order. ``turn_id`` comes only from ``turn/started`` and
    ``turn/completed``: a ``turn/start`` answer can race the old turn's end. The lock guards the session's fields and
    is never held across a request to Codex, so office stop, Esc and answers never wait on Codex.
    """

    def __init__(self, owner: "CodexSessions", session: Session, *, author: str | None) -> None:
        self.owner, self.store = owner, owner.store
        self.session_id, self.cwd, self.thread_id = session.id, session.cwd, session.harness_session_id
        self.author = author
        self.transcript = Transcript(self.store, session.id, owner.office.bus.publish_live)
        self.translator = Translator(self.transcript, session.cwd)
        self.process: CodexProcess | None = None
        self.launching: CodexProcess | None = None  # the app-server being started, which office stop kills too
        self.loading = False
        self.turn_id: str | None = None
        self.pending: list[str] = []
        self.ending = self.closed = self.stopped = False
        self._lock = threading.RLock()
        self._jobs: queue.Queue[tuple[Callable[..., Any], tuple[Any, ...]] | None] = queue.Queue()
        self._thread = threading.Thread(target=self._run, name=f"codex-{session.id}", daemon=True)
        self._thread.start()

    # --- request threads -------------------------------------------------------------

    def start(self, *, resume: bool = False) -> None:
        """Load the thread (``thread/resume`` when ``resume``) on the session's own thread."""
        with self._lock:
            self.loading = True
        self._post(self._load, resume)

    def launching_as(self, process: CodexProcess) -> bool:
        """Record ``process`` as the app-server being started, so office stop kills it; False once stopped."""
        with self._lock:
            if self.stopped:
                return False
            self.launching = process
            return True

    # --- app-server callbacks (reader thread): hand off ------------------------------

    def notified(self, method: str, params: dict[str, Any]) -> None:
        self._post(self._notification, method, params)

    def requested(self, request_id: Any, method: str, params: dict[str, Any]) -> None:
        self._post(self._request, request_id, method, params)

    def exited(self, process: CodexProcess) -> None:
        self._post(self._exited, process)

    # --- the session's thread --------------------------------------------------------

    def _post(self, fn: Callable[..., Any], *args: Any) -> None:
        self._jobs.put((fn, args))

    def _run(self) -> None:
        while (job := self._jobs.get()) is not None:
            fn, args = job
            try:
                fn(*args)
            except Exception:
                log.exception("codex session %s: %s failed", self.session_id, getattr(fn, "__name__", fn))

    def _load(self, resume: bool) -> None:
        try:
            process = self.owner.launch(self)
            params = owner_load(self.cwd, self.owner.policy(self.session_id))
            # The office never reads past turns, so a resume needn't send them.
            result = (process.rpc.request("thread/resume", {"threadId": self.thread_id, "excludeTurns": True, **params})
                      if resume else process.rpc.request("thread/start", params))
        except Exception:
            with self._lock:
                process, self.launching = self.launching, None
            if process is not None:
                process.kill()
            log.exception("codex session %s can't load its thread", self.session_id)
            return
        with self._lock:
            self.launching, self.process = None, process
        self.thread_id = result["thread"]["id"]
        self.store.update_session(self.session_id, harness_session_id=self.thread_id, harness_model=result.get("model"))
        self._flush()

    def _flush(self) -> None:
        """Go idle once loaded."""
        with self._lock:
            self.loading = False
            self._idle()

    def _notification(self, method: str, params: dict[str, Any]) -> None:
        if not self.translator.notification(method, params):
            log.debug("codex session %s: ignored %s", self.session_id, method)

    def _request(self, request_id: Any, method: str, params: dict[str, Any]) -> None:
        # Until approvals come to cards, Codex hears that the office serves no requests.
        process = self.process
        if process is not None:
            process.rpc.reply_error(request_id, -32601, f"agent-corp doesn't serve {method} yet")

    def _exited(self, process: CodexProcess) -> None:
        if process is not self.process or process.closing:
            return
        log.warning("codex app-server of session %s exited unexpectedly", self.session_id)

    def _idle(self) -> None:
        """(Under the lock.) Go idle."""
        self.store.update_session(self.session_id, status="idle")

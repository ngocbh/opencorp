"""One Codex session the owner drives: its app-server, its thread, its transcript and its turns."""

import logging
import queue
import threading
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from agent_corp.chat.harness import HarnessError
from agent_corp.chat.transcript import Transcript
from agent_corp.harness.codex import CodexProcess, CodexStartError, owner_load
from agent_corp.harness.rpc import RpcClosed, RpcError
from agent_corp.harness.translate import Translator
from agent_corp.protocol.models import Session

if TYPE_CHECKING:
    from agent_corp.harness.sessions import CodexSessions

log = logging.getLogger(__name__)


def why(exc: Exception) -> str:
    """What an error part says about a failed load: what to do, then the stderr tail."""
    if isinstance(exc, CodexStartError):
        return f"{exc}\n{exc.tail}".strip()
    if isinstance(exc, RpcError):
        return f"Codex refused to load the thread: {exc.message}"
    if isinstance(exc, TimeoutError):
        return f"Codex didn't answer in time: {exc}"
    return "Codex couldn't start; see the office log."


def _input(text: str) -> list[dict[str, Any]]:
    return [{"type": "text", "text": text, "text_elements": []}]


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

    def prompt(self, text: str, *, by: str | None) -> str:
        """A message from ``by`` (the opener when None): ``turn``, ``steer`` (a turn was running), or ``queued``
        (until the thread is loaded)."""
        with self._lock:
            if self.ending:
                raise HarnessError(409, "ending", f"session {self.session_id} is ending")
            self.transcript.user(text, author=by or self.author)
            if self.loading or self.process is None:
                self.pending.append(text)
                return "queued"
            process, busy = self.process, self.turn_id is not None
        try:
            return self._send(process, text, busy)
        except HarnessError:
            with self._lock:
                if self.turn_id is None:
                    self._idle()  # a refused message leaves the session idle
            raise

    def shutdown(self) -> None:
        """Office stop: kill the app-server (or the one still starting) and stop the session's thread; the stored
        status stays for ``restore``.

        Once it returns the session no longer touches the store.
        """
        with self._lock:
            self.stopped = True
            doomed = [p for p in (self.process, self.launching) if p is not None]
            self.process = None
        for process in doomed:  # a load or a turn/start waiting on Codex fails at once
            process.kill()
        self._jobs.put(None)
        if threading.current_thread() is not self._thread:
            self._thread.join(10)
            if self._thread.is_alive():
                log.warning("codex session %s: its thread is still busy at office stop", self.session_id)

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
            if self.stopped:  # office stop: no job touches the store any more
                continue
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
        except Exception as exc:
            with self._lock:
                process, self.launching = self.launching, None
            if process is not None:
                process.kill()
            self._cant_load(exc)
            return
        with self._lock:
            self.launching = None
            if not self.stopped:
                self.process = process
        if self.stopped:  # office stop came during the load: write nothing, leave nothing running
            process.kill()
            return
        self.thread_id = result["thread"]["id"]
        self.store.update_session(self.session_id, harness_session_id=self.thread_id, harness_model=result.get("model"))
        self._flush()

    def _cant_load(self, exc: Exception) -> None:
        if self.stopped:
            return  # office stop: the session keeps its status for restore
        if not isinstance(exc, (CodexStartError, RpcError)):
            log.exception("codex session %s can't load its thread", self.session_id)
        self.transcript.error(why(exc))
        with self._lock:
            self.loading = False
            self.pending.clear()
            if self.ending:
                return  # the end posted meanwhile closes it
            self.closed = True
        self.owner.finished(self, "failed")
        self._jobs.put(None)

    def _flush(self) -> None:
        """Go idle once loaded."""
        with self._lock:
            self.loading = False
            self._idle()

    def _send(self, process: CodexProcess, text: str, busy: bool) -> str:
        """turn/start: a new turn, or a steer of the running one (Codex decides; turn/started says which)."""
        try:
            process.rpc.request("turn/start", {"threadId": self.thread_id, "input": _input(text)})
        except (RpcError, RpcClosed) as exc:
            raise HarnessError(409, "codex_refused", f"Codex didn't take the message: {exc}") from exc
        return "steer" if busy else "turn"

    def _notification(self, method: str, params: dict[str, Any]) -> None:
        if self.translator.notification(method, params):
            return
        if method == "turn/started":
            with self._lock:
                self.turn_id = params["turn"]["id"]
                if not self.ending:
                    self.store.update_session(self.session_id, status="busy")
        elif method == "turn/completed":
            turn = params["turn"]
            self.translator.turn_completed(turn["id"], turn["status"], turn.get("error"))
            with self._lock:
                if turn["id"] == self.turn_id:
                    self.turn_id = None
                if self.turn_id is None and not self.loading and not self.ending:
                    self._idle()
        else:
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
        """(Under the lock.) Go idle. Nothing once the office stops."""
        if self.stopped:
            return
        self.store.update_session(self.session_id, status="idle")

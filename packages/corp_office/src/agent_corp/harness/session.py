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

STOP_WAIT = 10.0
"""Seconds office stop waits for the session's thread to finish the job it is in."""
END_WAIT = 10.0
"""Seconds an ending session waits for its interrupted turn to complete before it closes the app-server anyway."""


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
        self.timer: threading.Timer | None = None  # idle_end while idle; END_WAIT while ending
        self._idle_after: int | None = None  # idle_end in seconds, read once from the session's pinned company
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
            if self.stopped or self.closed:  # office stop, or a failed load not dropped yet
                raise HarnessError(409, "not_live", f"session {self.session_id} has no live Codex app-server")
            if self.ending:
                raise HarnessError(409, "ending", f"session {self.session_id} is ending")
            self.transcript.user(text, author=by or self.author)
            self._stop_timer()
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

    def interrupt(self) -> None:
        """Esc: ask Codex to interrupt the running turn; its ``turn/completed`` marks it."""
        with self._lock:
            turn, process = self.turn_id, self.process
        if turn is not None and process is not None:
            try:
                process.rpc.request("turn/interrupt", {"threadId": self.thread_id, "turnId": turn})
            except (RpcError, RpcClosed, TimeoutError):
                pass  # the turn ended meanwhile, the app-server is gone, or it hangs (its end or stop kills it)

    def end(self) -> None:
        """End the session: interrupt a running turn, close the app-server, then end through the hooks."""
        with self._lock:
            if self.stopped:
                raise HarnessError(409, "not_live", f"session {self.session_id} has no live Codex app-server")
            if self.ending:
                return  # already ending (or closing): ending it again is a no-op
            if self.closed:  # a failed load not dropped yet
                raise HarnessError(409, "not_live", f"session {self.session_id} has no live Codex app-server")
            self.ending = True
            self.pending.clear()
            self._stop_timer()
            busy = self.turn_id is not None
            self.store.update_session(self.session_id, status="ending")
            if busy:
                # Armed first: an interrupt Codex never answers fails at once when this closes the app-server.
                self.timer = threading.Timer(END_WAIT, self._post, (self._close,))
                self.timer.daemon = True
                self.timer.start()
        if busy:
            self.interrupt()  # turn/completed closes it; END_WAIT closes it if that never comes
        else:
            self._post(self._close)

    def shutdown(self) -> None:
        """Office stop: kill the app-server (or the one still starting) and stop the session's thread; the stored
        status stays for ``restore``. Text still streaming and tools still running are stored as interrupted, as
        composer's ``close_all`` stores them.

        Once it returns the session no longer touches the store.
        """
        with self._lock:
            self.stopped = True
            self._stop_timer()
            doomed = [p for p in (self.process, self.launching) if p is not None]
            self.process = None
        for process in doomed:  # a load or a turn/start waiting on Codex fails at once
            process.kill()
        self._jobs.put(None)
        busy = False
        if threading.current_thread() is not self._thread:
            self._thread.join(STOP_WAIT)
            busy = self._thread.is_alive()
        if busy:  # it may be writing to the transcript now; abort would race it, and it writes nothing after this job
            log.warning("codex session %s: its thread is still busy at office stop; its open text stays as it was",
                        self.session_id)
            return
        self.transcript.abort()

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
            if self.stopped or self.closed:  # office stop, or the session ended: no job touches the store any more
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
        """Send what waited for the load, in order, then go idle if nothing was sent. ``loading`` stays set until
        the queue is empty, so a message that comes meanwhile waits behind the queue instead of overtaking it."""
        sent = False
        while True:
            with self._lock:
                if self.stopped or self.ending:
                    return
                if not self.pending:
                    self.loading = False
                    if not sent and self.turn_id is None:
                        self._idle()
                    return
                text, process = "\n\n".join(self.pending), self.process
                self.pending.clear()
            try:
                self._send(process, text, sent)
                sent = True
            except HarnessError as exc:
                with self._lock:
                    if self.stopped:  # office stop killed the app-server: nothing refused it, and nothing is stored
                        return
                self.transcript.error(exc.message)

    def _send(self, process: CodexProcess, text: str, busy: bool) -> str:
        """turn/start: a new turn, or a steer of the running one (Codex decides; turn/started says which)."""
        try:
            process.rpc.request("turn/start", {"threadId": self.thread_id, "input": _input(text)})
        except (RpcError, RpcClosed, TimeoutError) as exc:
            raise HarnessError(409, "codex_refused", f"Codex didn't take the message: {exc}") from exc
        return "steer" if busy else "turn"

    def _notification(self, method: str, params: dict[str, Any]) -> None:
        if self.translator.notification(method, params):
            return
        if method == "turn/started":
            with self._lock:
                self.turn_id = params["turn"]["id"]
                self._stop_timer()
                if not self.ending:
                    self.store.update_session(self.session_id, status="busy")
        elif method == "turn/completed":
            turn = params["turn"]
            self.translator.turn_completed(turn["id"], turn["status"], turn.get("error"))
            with self._lock:
                if turn["id"] == self.turn_id:
                    self.turn_id = None
                if self.ending:
                    self._post(self._close)
                elif self.turn_id is None and not self.loading:
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

    def _close(self) -> None:
        with self._lock:
            if self.closed:
                return
            self.closed = True
            self._stop_timer()
            process = self.process
        if process is not None:
            process.close(self.owner.close_grace)  # stdin, grace, group kill, record removed: before end_status
        if self.stopped:
            return  # office stop came during the close: the session stays ending, for restore
        self.transcript.abort()
        self.owner.finished(self, "ended")
        self._jobs.put(None)  # nothing more to do: let the session's thread end after this job

    def _idle(self) -> None:
        """(Under the lock.) Go idle; ``idle_end`` later, the session ends. Nothing once the office stops or the
        session is ending."""
        if self.stopped or self.ending or self.closed:
            return
        self._stop_timer()
        self.store.update_session(self.session_id, status="idle")
        if self._idle_after is None:
            self._idle_after = self.owner.idle_seconds(self.session_id)
        timer = self.timer = threading.Timer(self._idle_after, self._post)
        timer.args = (self._idle_end, timer)  # the job knows its timer, so one a message stopped ends nothing
        timer.daemon = True
        timer.start()

    def _idle_end(self, timer: threading.Timer) -> None:
        with self._lock:
            still_idle = self.timer is timer and self.turn_id is None and not self.pending and not self.loading \
                and not self.ending
        if still_idle:
            try:
                self.end()
            except HarnessError:
                pass  # the office stopped meanwhile: restore decides

    def _stop_timer(self) -> None:
        """(Under the lock.) Cancel the idle or end timer."""
        if self.timer is not None:
            self.timer.cancel()
            self.timer = None

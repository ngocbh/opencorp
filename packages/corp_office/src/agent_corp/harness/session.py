"""One Codex session the owner drives: its app-server, its thread, its transcript and its turns."""

import logging
import queue
import re
import threading
from collections.abc import Callable
from concurrent.futures import CancelledError, Future
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from agent_corp.chat.harness import HarnessError
from agent_corp.chat.transcript import Transcript
from agent_corp.harness.codex import CodexProcess, CodexStartError, owner_load
from agent_corp.harness.rpc import RpcClosed, RpcError
from agent_corp.harness.translate import TURNLESS, Card, Translator, Unserved
from agent_corp.protocol.models import Session
from agent_corp.store import InvalidTransition, NotFound, Store, new_id

if TYPE_CHECKING:
    from agent_corp.harness.sessions import CodexSessions

log = logging.getLogger(__name__)

STOP_WAIT = 10.0
"""Seconds office stop waits for the session's thread to finish the job it is in."""
END_WAIT = 10.0
"""Seconds an ending session waits for its interrupted turn to complete before it closes the app-server anyway."""
REPLY_WAIT = 30.0
"""Seconds an answer waits for the session's thread to write its reply."""
_NOT_LOADED = re.compile(r"^thread not (found|loaded)\b")
"""Codex's turn/start error for a thread it has unloaded."""
_WRITER_LOCK = re.compile(r"\balready has an active writer\b", re.I)
"""Codex's thread/resume error for a thread another app-server (a Codex window, ``codex exec``) has loaded."""
OPEN_ELSEWHERE = "This Codex session is open in another Codex window or process; close it there and try again."


def why(exc: Exception) -> str:
    """What an error part says about a failed load: what to do, then the stderr tail."""
    if isinstance(exc, CodexStartError):
        return f"{exc}\n{exc.tail}".strip()
    if isinstance(exc, RpcError) and _WRITER_LOCK.search(exc.message):
        return OPEN_ELSEWHERE
    if isinstance(exc, RpcError):
        return f"Codex refused to load the thread: {exc.message}"
    if isinstance(exc, TimeoutError):
        return f"Codex didn't answer in time: {exc}"
    return "Codex couldn't start; see the office log."


_USAGE = ("input_tokens", "cached_input_tokens", "output_tokens")


def usage_base(store: Store, session: Session) -> dict[str, int]:
    """The thread's token counts before ``session`` began: every earlier stretch's own counts, summed."""
    base = dict.fromkeys(_USAGE, 0)
    parent = store.get_session(session.parent_session_id) if session.parent_session_id else None
    while parent is not None:
        for key, value in (parent.harness_usage.model_dump() if parent.harness_usage else {}).items():
            base[key] += value
        parent = store.get_session(parent.parent_session_id) if parent.parent_session_id else None
    return base


def _input(text: str) -> list[dict[str, Any]]:
    return [{"type": "text", "text": text, "text_elements": []}]


@dataclass
class Pending:
    """A server request Codex waits on: its JSON-RPC id and its card."""

    request_id: Any
    card: Card


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
        self.base = usage_base(self.store, session)  # the thread's token counts before this stretch
        self.transcript = Transcript(self.store, session.id, owner.office.bus.publish_live)
        self.translator = Translator(self.transcript, session.cwd)
        self.process: CodexProcess | None = None
        self.launching: CodexProcess | None = None  # the app-server being started, which office stop kills too
        self.loading = False
        self.turn_id: str | None = None
        self.pending: list[str] = []
        self.requests: dict[str, Pending] = {}  # question id -> the request Codex waits on
        self.by_request: dict[str, str] = {}  # str(request id) -> question id
        self._turnless: tuple[CodexProcess, str] | None = None  # an app-server and its turnless requests' run id
        self.timer: threading.Timer | None = None  # idle_end while idle; END_WAIT while ending
        self._idle_after: int | None = None  # idle_end in seconds, read once by the load from the pinned company
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
                if not self.loading:
                    self.start(resume=True)  # a restarted office, a dead app-server, or an unloaded thread
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

    def reply(self, question_id: str, answer: Any, by: str | None) -> bool:
        """Write Codex's reply to a stored answer while Codex still waits for it; False if it doesn't any more.

        The reply is written on the session's thread, so the decision is on the tool part before any message the
        reply causes (the item's end, the turn's end) is handled.
        """
        done: Future[bool] = Future()
        # Stop and close set their flag under the lock before the thread ends, so this job either runs or is
        # cancelled; it is never left in a queue no one reads.
        with self._lock:
            if self.stopped or self.closed:
                return False
            self._post(self._reply, question_id, answer, by, done)
        try:
            return done.result(timeout=REPLY_WAIT)
        except CancelledError:
            return False  # the office stopped first
        except FutureTimeout:
            return False if done.cancel() else done.result()

    def shutdown(self) -> None:
        """Office stop: kill the app-server (or the one still starting) and stop the session's thread; the stored
        status stays for ``restore``. Text still streaming and tools still running are stored as interrupted, as
        composer's ``close_all`` stores them. Answers still waiting for their reply give up at once.

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
        while True:  # jobs behind the stop never run: an answer waiting on one stops waiting
            try:
                job = self._jobs.get_nowait()
            except queue.Empty:
                break
            _cancel(job[1] if job else ())
        self._jobs.put(None)  # the drain took the stop too: put it back, so a thread still in its job ends after it
        if busy:  # it may be writing to the transcript now; abort would race it, and it writes nothing after this job
            log.warning("codex session %s: its thread is still busy at office stop; its open text stays as it was",
                        self.session_id)
            return
        self.transcript.abort()

    def stop(self) -> None:
        """Let the session's thread end, for a session restored only to be finished."""
        with self._lock:
            self.closed = True
            self._jobs.put(None)

    def idle_after_restore(self) -> None:
        """Go idle with no app-server, as a restarted office finds the session: its next message reloads the thread,
        and ``idle_end`` (read on the session's thread) ends it if none comes."""
        with self._lock:
            self._idle()
        self._post(self._idle_end_after_restore)

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
                _cancel(args)
                continue
            try:
                fn(*args)
            except Exception:
                log.exception("codex session %s: %s failed", self.session_id, getattr(fn, "__name__", fn))

    def _load(self, resume: bool) -> None:
        try:
            idle_after = self.owner.idle_seconds(self.session_id)  # here, not under the lock: it reads the company
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
        self.thread_id, self._idle_after = result["thread"]["id"], idle_after
        self.store.update_session(self.session_id, harness_session_id=self.thread_id, harness_model=result.get("model"))
        self._flush()

    def _cant_load(self, exc: Exception) -> None:
        if self.stopped:
            return  # office stop: the session keeps its status for restore
        if not isinstance(exc, (CodexStartError, RpcError)):
            log.exception("codex session %s can't load its thread", self.session_id)
        self.transcript.error(why(exc))
        session = self.store.get_session(self.session_id)
        with self._lock:
            self.loading = False
            self.pending.clear()
            if self.ending:
                return  # the end posted meanwhile closes it
            if session.status != "starting":  # a reload: say why and wait for the next message
                self._idle()
                return
            self.closed = True
        self.owner.finished(self, "failed")
        self._jobs.put(None)

    def _idle_end_after_restore(self) -> None:
        idle_after = self.owner.idle_seconds(self.session_id)  # not under the lock: it reads the company
        with self._lock:
            if self._idle_after is not None or self.loading or self.process is not None or self.turn_id is not None:
                return  # a message came first: its load reads idle_end
            self._idle_after = idle_after
            self._idle()

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
                if self._send(process, text, sent) == "queued":
                    return  # Codex had unloaded the thread: the reload sends it
                sent = True
            except HarnessError as exc:
                with self._lock:
                    if self.stopped:  # office stop killed the app-server: nothing refused it, and nothing is stored
                        return
                self.transcript.error(exc.message)

    def _send(self, process: CodexProcess, text: str, busy: bool) -> str:
        """turn/start: a new turn, or a steer of the running one (Codex decides; turn/started says which).
        ``queued`` when Codex had unloaded the thread: the message waits for the reload."""
        try:
            process.rpc.request("turn/start", {"threadId": self.thread_id, "input": _input(text)})
        except RpcError as exc:
            if not _NOT_LOADED.match(exc.message):
                raise HarnessError(409, "codex_refused", f"Codex didn't take the message: {exc}") from exc
            self._reload(process, text)
            return "queued"
        except (RpcClosed, TimeoutError) as exc:
            raise HarnessError(409, "codex_refused", f"Codex didn't take the message: {exc}") from exc
        return "steer" if busy else "turn"

    def _reload(self, process: CodexProcess, text: str) -> None:
        """Codex unloaded the thread: close its app-server, then load the thread again; ``text`` waits for it."""
        with self._lock:
            if self.stopped or self.ending:
                return  # office stop keeps the session for restore; an end closes it
            self.pending.append(text)
            if self.process is not process:  # another message got there first, or the app-server died meanwhile
                if not self.loading:  # and nothing is loading now: send it on the new app-server, or load one
                    self.loading = True
                    if self.process is None:
                        self._post(self._load, True)
                    else:
                        self._post(self._flush)
                return
            self.process, self.loading = None, True
        process.close(self.owner.close_grace)  # its record goes before the reload writes the new one
        self._post(self._load, True)

    def _notification(self, method: str, params: dict[str, Any]) -> None:
        if self.translator.notification(method, params):
            return
        if method == "turn/started":
            with self._lock:
                self.turn_id = params["turn"]["id"]
                if not self.ending:  # while ending, the timer is END_WAIT's, which must still close the session
                    self._stop_timer()
                    self.store.update_session(self.session_id, status="busy")
        elif method == "turn/completed":
            turn = params["turn"]
            self.translator.turn_completed(turn["id"], turn["status"], turn.get("error"))
            with self._lock:
                if turn["id"] == self.turn_id:
                    self.turn_id = None
                self._expire_turn(turn["id"])
                if self.ending:
                    self._post(self._close)
                elif self.turn_id is None and not self.loading:
                    self._idle()
        elif method == "serverRequest/resolved":
            self._resolved(params["requestId"])
        elif method == "thread/tokenUsage/updated":
            self._usage(params["tokenUsage"]["total"])
        elif method == "thread/closed" and self.process is not None:
            self._lost(self.process, None)
        else:
            log.debug("codex session %s: ignored %s", self.session_id, method)

    def _usage(self, total: dict[str, Any]) -> None:
        # Codex counts the whole thread; a continued session keeps only its own stretch's tokens.
        got = {"input_tokens": total["inputTokens"], "cached_input_tokens": total["cachedInputTokens"],
               "output_tokens": total["outputTokens"]}
        self.store.update_session(self.session_id,
                                  harness_usage={k: max(0, v - self.base[k]) for k, v in got.items()})

    def _request(self, request_id: Any, method: str, params: dict[str, Any]) -> None:
        """A server request: a card the owner answers, or a JSON-RPC error for a method the office doesn't serve."""
        process = self.process
        if process is None:
            return
        session = self.store.get_session(self.session_id)
        run_id = params.get("turnId") or self._turnless_run(process)
        try:
            card = self.translator.card(method, params, session=session, run_id=run_id, node_id=str(request_id))
        except Unserved:
            self._refuse(process, request_id, -32601, f"agent-corp doesn't serve {method}")
            return
        except Exception:  # a request shaped other than the pinned schema says: Codex would wait on it until Esc
            log.exception("codex session %s: no card can be made for %s", self.session_id, method)
            self._refuse(process, request_id, -32603, f"agent-corp couldn't read {method}")
            return
        try:
            self.store.add_question(card.question)
        except Exception:  # no card to answer: Codex hears so now rather than waiting until Esc
            log.exception("codex session %s: the card for %s wasn't stored", self.session_id, method)
            self._refuse(process, request_id, -32603, f"agent-corp couldn't show {method}")
            return
        # Registered once the card exists; an answer to it runs on this thread, so it can't come before this.
        with self._lock:
            self.requests[card.question.id] = Pending(request_id, card)
            self.by_request[str(request_id)] = card.question.id

    def _turnless_run(self, process: CodexProcess) -> str:
        """The run id of ``process``'s requests with no turn. Request ids restart with each app-server and a pid can
        come back, so each app-server gets one of its own."""
        if self._turnless is None or self._turnless[0] is not process:
            self._turnless = (process, f"{TURNLESS}{process.pid}-{new_id()}")
        return self._turnless[1]

    def _reply(self, question_id: str, answer: Any, by: str | None, done: "Future[bool]") -> None:
        if not done.set_running_or_notify_cancel():
            # The answerer gave up waiting and expired the card, so no answer can come: tell Codex now.
            pending, process = self._take(question_id)
            if pending is not None and process is not None:
                self._refuse(process, pending.request_id, -32603, "the answer came too late")
            return
        try:
            done.set_result(self._write_reply(question_id, answer, by))
        except Exception as exc:  # the answerer waits on this future: it must hear of the failure
            done.set_exception(exc)

    def _take(self, question_id: str) -> tuple[Pending | None, CodexProcess | None]:
        """Take the request a card stands for off the waiting ones, with the app-server to answer it on."""
        with self._lock:  # only the bookkeeping: the write to Codex is outside it, as every request is
            pending, process = self.requests.pop(question_id, None), self.process
            if pending is not None:
                self.by_request.pop(str(pending.request_id), None)
        return pending, process

    def _write_reply(self, question_id: str, answer: Any, by: str | None) -> bool:
        pending, process = self._take(question_id)
        if pending is None or process is None or not process.alive:
            return False
        try:
            result, decision = pending.card.reply(answer)
        except Exception as exc:
            # Codex treats an error reply as a refusal and goes on; with no reply it would wait until Esc.
            log.warning("codex session %s: no reply can be made from the answer to %s: %s", self.session_id,
                        question_id, exc)
            self._refuse(process, pending.request_id, -32602, f"agent-corp couldn't use the answer: {exc}")
            return False
        try:
            process.rpc.reply(pending.request_id, result)
        except RpcClosed:
            return False
        # Codex has the reply, so the answer stands whatever is left to write; a failure is logged, not raised.
        try:
            self.store.set_question_status(question_id, "consumed")
        except Exception:
            log.exception("codex session %s: card %s wasn't marked consumed", self.session_id, question_id)
        try:
            self.translator.decided(pending.card, decision, by or self.author)
        except Exception:
            log.exception("codex session %s: the decision on %s wasn't written", self.session_id, question_id)
        return True

    def _resolved(self, request_id: Any) -> None:
        """Codex no longer waits on ``request_id``: an open card goes stale; an answer stored meanwhile is lost by
        ``reply`` returning False."""
        with self._lock:
            question_id = self.by_request.pop(str(request_id), None)
            pending = self.requests.pop(question_id, None) if question_id else None
        if pending is not None:
            self._expire(question_id)

    def _expire_turn(self, turn_id: str) -> None:
        """(Under the lock.) Cards of a finished turn that Codex didn't resolve go stale: it waits on them no more.
        Codex sends no ``serverRequest/resolved`` for a request an interrupt leaves waiting."""
        for question_id, pending in list(self.requests.items()):
            if pending.card.question.run_id == turn_id:
                del self.requests[question_id]
                self.by_request.pop(str(pending.request_id), None)
                self._expire(question_id)

    def _expire(self, question_id: str) -> None:
        try:
            self.store.set_question_status(question_id, "stale")
        except InvalidTransition:
            pass  # answered meanwhile: its reply finds no pending request and loses the answer
        except NotFound:
            log.warning("codex session %s: card %s is gone", self.session_id, question_id)

    def _refuse(self, process: CodexProcess, request_id: Any, code: int, message: str) -> None:
        try:
            process.rpc.reply_error(request_id, code, message)
        except RpcClosed:
            pass  # the app-server is gone: nothing waits on the answer

    def _exited(self, process: CodexProcess) -> None:
        if process is not self.process or process.closing:
            return
        log.warning("codex app-server of session %s exited unexpectedly", self.session_id)
        self._lost(process, "Codex stopped unexpectedly. Send a message to start it again.")

    def _lost(self, process: CodexProcess, said: str | None) -> None:
        """The app-server died, or Codex unloaded the thread: finish its turn as interrupted, expire its cards, and
        close its group now; the next message reloads the thread. ``said`` is the error part, with the stderr tail."""
        with self._lock:
            self.process = None
            turn, self.turn_id = self.turn_id, None
            for question_id in list(self.requests):  # Codex waits on none of them any more
                self.requests.pop(question_id)
                self._expire(question_id)
            self.by_request.clear()
        tail = process.stderr_tail() if said else ""
        # A dead leader leaves its group to whatever it started (command children, #57): kill it now, which also
        # removes the record, so an end or idle_end that comes before any reload never finds them.
        process.kill()
        if self.stopped:
            return  # office stop came meanwhile: restore marks the turn, and nothing is written after the stop
        if turn is not None:
            self.translator.turn_completed(turn, "interrupted", None)
        if said:
            self.transcript.error(said + (f"\n{tail}" if tail else ""))
        with self._lock:
            if self.ending:
                self._post(self._close)
            else:
                self._idle()

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
        if self._idle_after is None:  # not loaded yet
            return
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


def _cancel(args: tuple[Any, ...]) -> None:
    """Cancel the answer waiting on a job that will never run, so it gives up at once."""
    for arg in args:
        if isinstance(arg, Future):
            arg.cancel()

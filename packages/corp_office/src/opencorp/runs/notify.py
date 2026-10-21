"""run.updated for what the store doesn't see (a run's open nodes): the first change at once, then at most one a
second per run, the last change always sent. These go straight to the bus: its stream has no replay, and an outbox
row per node would be too many writes; coalescing keeps a busy run from getting HQ's subscribers dropped."""

import logging
import math
import threading
import time
from collections.abc import Callable

from opencorp.protocol import now
from opencorp.protocol.models import Event, RunUpdated
from opencorp.store import new_id

log = logging.getLogger(__name__)

EVERY_S = 1.0


def run_updated(run_id: str, session_id: str, parent_run_id: str | None, status: str,
                current_nodes: list[str]) -> Event:
    """A run.updated event, shaped as the outbox writes one."""
    data = RunUpdated(run_id=run_id, session_id=session_id, parent_run_id=parent_run_id, status=status,
                      current_nodes=current_nodes)
    return Event(id=new_id(), type="run.updated", at=now(), subject_id=run_id, data=data.model_dump(mode="json"))


class RunNotifier:
    """Sends run changes through ``publish`` (the bus's ``publish_meta``), coalesced per run to one each ``every``
    seconds. One thread sends the trailing events; ``close`` stops it."""

    def __init__(self, publish: Callable[[Event], None], *, every: float = EVERY_S,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._publish, self._every, self._clock = publish, every, clock
        self._sent: dict[str, float] = {}  # run id -> when its last event went
        self._dirty: dict[str, Callable[[], Event | None]] = {}  # run id -> how to build its next event
        self._cond = threading.Condition()
        self._thread: threading.Thread | None = None
        self._closed = False

    def changed(self, run_id: str, event: Callable[[], Event | None]) -> None:
        """Run ``run_id`` changed; ``event()`` builds its run.updated when it is sent (None: nothing to send).

        The first change in a while goes at once, from the caller's thread; later ones within ``every`` seconds are
        coalesced, and the notifier's thread sends the last of them."""
        with self._cond:
            if self._closed:
                return
            at = self._clock()
            if run_id not in self._dirty and at - self._sent.get(run_id, -math.inf) >= self._every:
                self._sent[run_id] = at
            else:
                self._dirty[run_id] = event
                if self._thread is None:
                    self._thread = threading.Thread(target=self._run, name="run-notifier", daemon=True)
                    self._thread.start()
                self._cond.notify()
                return
        self._send(event)

    def close(self) -> None:
        """Stop the thread; changes still waiting are dropped (clients refetch when they reconnect)."""
        with self._cond:
            self._closed = True
            self._cond.notify_all()
            thread = self._thread
        if thread is not None:
            thread.join(5)

    def _run(self) -> None:
        while (due := self._next()) is not None:
            for event in due:
                self._send(event)

    def _next(self) -> list[Callable[[], Event | None]] | None:
        """The changes due now, waiting until one is; None once closed."""
        with self._cond:
            while not self._closed:
                at = self._clock()
                due = [r for r in self._dirty if at - self._sent.get(r, -math.inf) >= self._every]
                if due:
                    for run_id in due:
                        self._sent[run_id] = at
                    quiet = [r for r, t in self._sent.items() if at - t > 10 * self._every and r not in self._dirty]
                    for run_id in quiet:
                        del self._sent[run_id]  # long quiet: forgotten, so the map stays small
                    return [self._dirty.pop(r) for r in due]
                wait = min((self._sent.get(r, at) + self._every for r in self._dirty), default=None)
                self._cond.wait(None if wait is None else max(0.0, wait - at))
            return None

    def _send(self, event: Callable[[], Event | None]) -> None:
        try:
            built = event()
            if built is not None:
                self._publish(built)
        except Exception:
            log.exception("couldn't send a run.updated")

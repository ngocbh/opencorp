"""The office's in-process event bus: stored metadata events and live transcript events."""

import asyncio
from typing import Literal

from agent_corp.protocol.models import Event, LiveEvent

type Item = tuple[Literal["meta"], Event] | tuple[Literal["live"], LiveEvent]


class _Ping:
    def __repr__(self) -> str:
        return "PING"


PING = _Ping()
"""What ``Subscription.next`` returns when nothing arrived before the timeout."""


class Subscription:
    """One subscriber's queue of bus items, optionally for one session."""

    def __init__(self, bus: "Bus", session: str | None) -> None:
        self._bus = bus
        self.session = session
        self._queue: asyncio.Queue[Item | None] = asyncio.Queue()
        self._done = False

    def matches(self, item: Item) -> bool:
        """Whether ``item`` belongs to this subscription's session (always, without one)."""
        if self.session is None:
            return True
        kind, event = item
        if kind == "live":
            return event.session_id == self.session
        return event.subject_id == self.session or event.data.get("session_id") == self.session

    async def next(self, timeout: float) -> Item | _Ping | None:
        """The next item, ``PING`` after ``timeout`` seconds idle, or ``None`` once ended."""
        if self._done:
            return None
        try:
            item = await asyncio.wait_for(self._queue.get(), timeout)
        except TimeoutError:
            return PING
        if item is None:
            self._done = True
        return item

    def close(self) -> None:
        """Stop receiving items."""
        self._done = True
        self._bus._remove(self)

    def _end(self) -> None:
        self._queue.put_nowait(None)


class Bus:
    """Fans office events out to subscribers on the office loop.

    ``publish_*`` may be called from any thread: every publish is scheduled on the loop with
    ``call_soon_threadsafe``, so all of them keep one order. A subscriber whose backlog reaches
    ``queue_size`` is dropped (its stream ends; the client reconnects and re-bootstraps).
    """

    def __init__(self, *, queue_size: int = 1000) -> None:
        self.queue_size = queue_size
        self._loop: asyncio.AbstractEventLoop | None = None
        self._subs: list[Subscription] = []
        self._closed = False

    @property
    def attached(self) -> bool:
        """Whether the bus is bound to a loop."""
        return self._loop is not None

    @property
    def subscriber_count(self) -> int:
        """How many subscriptions are live."""
        return len(self._subs)

    def attach(self, loop: asyncio.AbstractEventLoop) -> None:
        """Bind the bus to the office loop."""
        self._loop = loop

    def publish_meta(self, event: Event) -> None:
        """Publish a stored metadata event (a store listener; never blocks)."""
        self._post(("meta", event))

    def publish_live(self, event: LiveEvent) -> None:
        """Publish a live transcript event."""
        self._post(("live", event))

    def subscribe(self, session: str | None = None) -> Subscription:
        """A new subscription to every event, or to one session's."""
        sub = Subscription(self, session)
        if self._closed:
            sub._end()
        else:
            self._subs.append(sub)
        return sub

    def close(self) -> None:
        """End every subscription and drop later publishes. Safe from any thread."""
        loop = self._loop
        if loop is None or loop.is_closed():
            self._close()
        else:
            try:
                running = asyncio.get_running_loop()
            except RuntimeError:
                running = None
            if running is loop:
                self._close()
            else:
                loop.call_soon_threadsafe(self._close)

    def _close(self) -> None:
        self._closed = True
        for sub in self._subs:
            sub._end()
        self._subs.clear()

    def _post(self, item: Item) -> None:
        loop = self._loop
        if loop is None or self._closed or loop.is_closed():
            return
        loop.call_soon_threadsafe(self._fanout, item)

    def _fanout(self, item: Item) -> None:
        for sub in list(self._subs):
            if not sub.matches(item):
                continue
            if sub._queue.qsize() >= self.queue_size:
                self._subs.remove(sub)
                sub._end()
            else:
                sub._queue.put_nowait(item)

    def _remove(self, sub: Subscription) -> None:
        if sub in self._subs:
            self._subs.remove(sub)

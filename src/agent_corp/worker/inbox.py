"""Steer and interrupt requests for a worker's running nodes."""

import threading


class Inbox:
    """composer's ``Steering`` inbox, fed by the office's ``steer`` and ``interrupt`` frames.

    Once a node is finished, new steers and interrupts for it are refused, so the
    office can hand the text back to the person.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._queued: dict[str, list[str]] = {}
        self._stops: set[str] = set()
        self._finished: set[str] = set()

    def steer(self, node_id: str, text: str) -> bool:
        """Queue ``text`` for ``node_id``; False if the node already finished."""
        with self._lock:
            if node_id in self._finished:
                return False
            self._queued.setdefault(node_id, []).append(text)
            return True

    def interrupt(self, node_id: str) -> bool:
        """Ask ``node_id`` to stop; False if it already finished."""
        with self._lock:
            if node_id in self._finished:
                return False
            self._stops.add(node_id)
            return True

    def drain(self, node_id: str) -> list[str]:
        """Remove and return ``node_id``'s queued steers, oldest first."""
        with self._lock:
            return self._queued.pop(node_id, [])

    def interrupted(self, node_id: str) -> bool:
        """Whether ``node_id`` was asked to stop."""
        with self._lock:
            return node_id in self._stops

    def finish(self, node_id: str) -> list[str]:
        """Mark ``node_id`` finished; return the steers it never read."""
        with self._lock:
            self._finished.add(node_id)
            self._stops.discard(node_id)
            return self._queued.pop(node_id, [])

    def leftovers(self) -> dict[str, list[str]]:
        """Remove and return every queued steer, by node id."""
        with self._lock:
            queued, self._queued = self._queued, {}
            return queued

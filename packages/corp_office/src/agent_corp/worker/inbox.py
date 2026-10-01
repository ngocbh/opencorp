"""Steer and interrupt requests for a worker's running nodes."""

import threading


class Inbox:
    """composer's ``Steering`` inbox, fed by the office's ``steer`` and ``interrupt`` frames.

    A steer for a node that hasn't started waits until the node drains it; so does an
    interrupt, which stops the node once it starts. Once a node is finished, new steers and
    interrupts for it are refused (a refused interrupt is dropped; a refused steer goes back
    to the office). ``close`` at the end of the run refuses everything and returns every
    steer never read, including those for nodes that never ran. A resumed run's inbox
    doesn't know the nodes finished before the resume, so their steers wait until ``close``.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._queued: dict[str, list[str]] = {}
        self._stops: set[str] = set()
        self._cut: set[str] = set()  # nodes that read their interrupt, which composer then stops
        self._finished: set[str] = set()
        self._closed = False

    def steer(self, node_id: str, text: str) -> bool:
        """Queue ``text`` for ``node_id``; False if the node finished or the inbox is closed."""
        with self._lock:
            if self._closed or node_id in self._finished:
                return False
            self._queued.setdefault(node_id, []).append(text)
            return True

    def interrupt(self, node_id: str) -> bool:
        """Ask ``node_id`` to stop; False if it finished or the inbox is closed."""
        with self._lock:
            if self._closed or node_id in self._finished:
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
            if node_id in self._stops:
                self._cut.add(node_id)
                return True
            return False

    def cut(self, node_id: str) -> bool:
        """Whether ``node_id`` read its interrupt, and so stopped short of its full reply."""
        with self._lock:
            return node_id in self._cut

    def finish(self, node_id: str) -> list[str]:
        """Mark ``node_id`` finished; return the steers it never read."""
        with self._lock:
            self._finished.add(node_id)
            self._stops.discard(node_id)
            self._cut.discard(node_id)
            return self._queued.pop(node_id, [])

    def close(self) -> dict[str, list[str]]:
        """Refuse every later steer and interrupt; remove and return every queued steer, by node id."""
        with self._lock:
            self._closed = True
            self._stops.clear()
            self._cut.clear()
            queued, self._queued = self._queued, {}
            return queued

"""The nodes a run is executing now, from its worker's event frames: what the list and run.updated show, with no log
read."""

import threading
from typing import Any

STARTED = "NodeStarted"
ENDED = frozenset({"NodeSucceeded", "NodeRouted", "NodeSkipped", "NodeFailed", "NodeExpanded"})
"""Every frame that ends a node: a case ends routed, a loop or map spawner expanded (yian/events.py)."""
CAP = 64
"""The most open nodes kept: a run's open nodes are bounded by its widest map."""


class OpenNodes:
    """Node ids started and not yet ended, in start order. Frames arrive on a worker's reader thread and reads come
    from requests, so it locks."""

    def __init__(self) -> None:
        self._ids: dict[str, None] = {}
        self._lock = threading.Lock()

    def apply(self, name: str, data: dict[str, Any]) -> bool:
        """Fold one event frame in; returns whether the open nodes changed."""
        failure = data.get("failure") if isinstance(data.get("failure"), dict) else {}
        node_id = data.get("node_id") or failure.get("node_id")
        if not isinstance(node_id, str):
            return False
        with self._lock:
            if name == STARTED and node_id not in self._ids:
                self._ids[node_id] = None
                while len(self._ids) > CAP:
                    del self._ids[next(iter(self._ids))]
                return True
            if name in ENDED and node_id in self._ids:
                del self._ids[node_id]
                return True
        return False

    def clear(self) -> None:
        """Forget every node: a new worker re-emits the starts of the nodes it re-runs."""
        with self._lock:
            self._ids.clear()

    def current(self) -> list[str]:
        """The open nodes, deepest only: an open node's ancestors are left out. ``chat`` is an ancestor of its
        iterations' nodes (``chat#12/reply``) and of its loop driver clones (``chat~12``)."""
        with self._lock:
            ids = list(self._ids)
        return [n for n in ids if not any(o != n and o.startswith((n + "/", n + "#", n + "~")) for o in ids)]

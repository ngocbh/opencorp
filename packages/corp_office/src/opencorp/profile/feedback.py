"""Feedback on a finished run: the handlers of its backward worker, and what each attempt's outcome means."""

import threading
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from typing import Any

from yian.memory.storage.markdown import MarkdownStore

from opencorp.profile.store import GitProfileStore
from opencorp.worker import BaseHandlers

MAX_ATTEMPTS = 3
"""Backward attempts per feedback before it is ``learning_failed``."""
MISMATCH = "profile.version_mismatch"
"""Composer's failure code when the profile changed after the learner read it."""


def next_status(outcome: Mapping[str, Any] | None, *, committed: bool, attempts: int) -> str:
    """What follows a backward attempt: ``applied``, ``retry`` (now), ``retry_later``, or ``learning_failed``.

    ``outcome`` is the worker's result or error frame (None if it died), ``committed``
    whether the attempt committed a profile write, and ``attempts`` how many were made. A
    mismatch retries at once as a new attempt; any other failure retries later only if
    nothing was committed; either way there are at most ``MAX_ATTEMPTS``.
    """
    backward = (outcome or {}).get("backward") or {}
    if backward.get("status") == "succeeded":
        return "applied"
    if committed:
        return "learning_failed"
    if attempts >= MAX_ATTEMPTS:
        return "learning_failed"
    failure = backward.get("failure") or {}
    return "retry" if failure.get("code") == MISMATCH else "retry_later"


def find_committed(stores: Mapping[str, Any], commit_ids: Iterable[str]) -> str | None:
    """The commit of the newest of ``commit_ids`` that a profile store in ``stores`` committed, or None."""
    commit_ids = list(commit_ids)
    for store in stores.values():
        if isinstance(store, GitProfileStore):
            for commit_id in reversed(commit_ids):
                if (sha := store.git.find_commit(store.path, f"Commit-Id: {commit_id}")) is not None:
                    return sha
    return None


def read_commit_log(path: Path) -> list[str]:
    """The commit ids a ``FeedbackHandlers`` wrote to ``path``, oldest first; none if there is no file."""
    try:
        return path.read_text().split()
    except FileNotFoundError:
        return []


class FeedbackHandlers(BaseHandlers):
    """A learning worker's handlers: profile writes are committed with ``source``; nobody answers questions.

    A backward worker gets a ``source``; a debrief worker (which writes nothing) needs none.
    ``exited(outcome)`` is called on the worker's reader thread once it exits, with its
    result or error frame, or None. Each write's commit id is also appended to ``commit_log``,
    so an office that stopped before taking the outcome can still find what the attempt committed.
    ``on_event(name, data)`` gets each event frame, on the worker's reader thread.
    """

    def __init__(self, *, tools: Mapping[str, Mapping[str, Any]] | None = None,
                 stores: Mapping[str, MarkdownStore] | None = None, source: str | None = None,
                 exited: Callable[[dict[str, Any] | None], None] | None = None,
                 commit_log: Path | None = None,
                 on_event: Callable[[str, dict[str, Any]], None] | None = None) -> None:
        super().__init__(tools=tools, stores=stores)
        self.source = source
        self.commit_log = commit_log
        self.commit_ids: list[str] = []
        self.outcome: dict[str, Any] | None = None
        self._on_exit = exited
        self._on_event = on_event
        self._lock = threading.Lock()

    def event(self, worker: Any, frame: dict[str, Any]) -> None:
        if self._on_event is not None:
            self._on_event(frame["name"], frame["data"])

    def store_write(self, worker: Any, store: str, text: str, base_version: str,
                    provenance: dict[str, Any] | None) -> str:
        provenance = dict(provenance or {})
        if self.source is not None:
            provenance["source"] = self.source
        if isinstance(provenance.get("commit_id"), str):
            with self._lock:  # recorded before the write, so a write whose reply is lost is still checked
                self.commit_ids.append(provenance["commit_id"])
                if self.commit_log is not None:
                    self.commit_log.parent.mkdir(parents=True, exist_ok=True)
                    with self.commit_log.open("a") as f:
                        f.write(provenance["commit_id"] + "\n")
        return super().store_write(worker, store, text, base_version, provenance)

    def result(self, worker: Any, frame: dict[str, Any]) -> None:
        self.outcome = frame

    def error(self, worker: Any, frame: dict[str, Any]) -> None:
        self.outcome = frame

    def exited(self, worker: Any, returncode: int) -> None:
        if self._on_exit is not None:
            self._on_exit(self.outcome)

    def committed(self) -> str | None:
        """The newest commit this attempt's profile writes made, or None."""
        with self._lock:
            commit_ids = list(self.commit_ids)
        return find_committed(self.stores, commit_ids)

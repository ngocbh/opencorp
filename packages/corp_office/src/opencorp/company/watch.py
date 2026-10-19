"""Polls the company clone's HEAD and records ``company.updated`` when it moves."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from opencorp.daemon.app import Office

log = logging.getLogger(__name__)


class HeadWatcher:
    """Emits ``company.updated`` (``subject_id`` and ``data.sha``: the new HEAD) each time the clone's HEAD moves.

    It polls, as Argo CD and Flux poll git, so the office's own commits and an outside commit to the clone both count.
    The first read only sets the baseline. ``start`` and ``stop`` are the office's ``on_start`` and ``on_stop``.
    """

    def __init__(self, office: Office, *, interval: float = 2.0) -> None:
        self.office = office
        self.interval = interval
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        """Start polling on the running loop."""
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        """Stop polling; harmless if it never started."""
        if self._task is None:
            return
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._task
        self._task = None

    def _head(self) -> str | None:
        try:
            return self.office.git.read_head()
        except ValueError:  # no commit yet
            return None

    async def _run(self) -> None:
        baseline, last = True, None
        while True:
            # Any failure (git missing, out of file descriptors, a locked store) is logged and the next poll tries
            # again: a watcher that died would stop company.updated until the office restarts.
            try:
                sha = self._head()
                if baseline:
                    baseline, last = False, sha
                elif sha is not None and sha != last:
                    # As profile.updated does for other metadata kept outside the store.
                    await asyncio.to_thread(self.office.store.emit, "company.updated", sha, {"sha": sha})
                    last = sha  # only once recorded, so a failed emit is retried
            except Exception:
                log.exception("couldn't check the company clone's HEAD or record company.updated")
            await asyncio.sleep(self.interval)

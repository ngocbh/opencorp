"""Kill workers left over from an earlier office."""

import os
import signal

import psutil

from opencorp.store import Store, WorkerRecord


def start_time(pid: int) -> float | None:
    """psutil's ``create_time()`` for ``pid``, or None if it can't be read."""
    try:
        return psutil.Process(pid).create_time()
    except psutil.Error:
        return None


def kill_group(pgid: int) -> bool:
    """SIGKILL process group ``pgid``; False if it is gone or may not be signalled.

    macOS answers ``EPERM`` for a group whose only members are zombies.
    """
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        return False
    return True


def reap(store: Store, session_id: str | None = None) -> list[WorkerRecord]:
    """Kill leftover workers recorded in ``store`` (only ``session_id``'s when given).

    A record's process group is killed only if its pid is alive with the recorded start
    time, so a reused pid is left alone. Every record looked at is removed. Returns the
    records whose groups were killed. The office calls it at start; ``WorkerRegistry.spawn``
    calls it for the session it starts.
    """
    killed = []
    for record in store.list_workers():
        if session_id is not None and record.session_id != session_id:
            continue
        if _same_process(record) and kill_group(record.pgid):
            killed.append(record)
        store.remove_worker(record.session_id)
    return killed


def _same_process(record: WorkerRecord) -> bool:
    found = start_time(record.pid)
    return found is not None and abs(found - record.start_time) < 0.01

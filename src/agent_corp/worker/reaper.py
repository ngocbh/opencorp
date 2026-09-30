"""Kill workers left over from an earlier office."""

import os
import signal

import psutil

from agent_corp.store import Store, WorkerRecord


def reap(store: Store, session_id: str | None = None) -> list[WorkerRecord]:
    """Kill leftover workers recorded in ``store`` (only ``session_id``'s when given).

    A record's process group is killed only if its pid is alive with the recorded start
    time, so a reused pid is left alone. Every record looked at is removed. Returns the
    records whose groups were killed. Call it at office start, and before a resume only
    when the registry has no live worker for the session.
    """
    killed = []
    for record in store.list_workers():
        if session_id is not None and record.session_id != session_id:
            continue
        if _same_process(record):
            try:
                os.killpg(record.pgid, signal.SIGKILL)
                killed.append(record)
            except ProcessLookupError:
                pass
        store.remove_worker(record.session_id)
    return killed


def _same_process(record: WorkerRecord) -> bool:
    try:
        return abs(psutil.Process(record.pid).create_time() - record.start_time) < 0.01
    except psutil.Error:
        return False

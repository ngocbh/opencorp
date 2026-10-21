"""A session's run state, and the status writes that must not race the steps that finish a session."""

from collections.abc import Iterable
from typing import Any

from opencorp.protocol.models import Session
from opencorp.store import Store


def guarded_update(store: Store, session_id: str, statuses: Iterable[str], **changes: Any) -> Session | None:
    """Change the session's fields only while its status is one of ``statuses``, in one store transaction.

    Returns the changed session, or None when there is no such session or its status had moved on (say,
    ``_finish`` wrote ``failed`` meanwhile).
    """
    allowed = tuple(statuses)
    with store.transaction():
        current = store.get_session(session_id)
        if current is None or current.status not in allowed:
            return None
        return store.update_session(session_id, **changes)


SETTLED = ("starting", "idle", "busy", "waiting")
"""The statuses the run state replaces. Ending, debriefing and finished ones are written only by their own steps."""


def run_state(*, waiting: bool, running: bool) -> str:
    """What the run waits in decides its state: someone must act (waiting), else a node runs (busy), else idle."""
    return "waiting" if waiting else "busy" if running else "idle"


def not_waiting(status: str) -> dict[str, Any]:
    """The fields that store ``status`` outside the run state (ending, debriefing or a finished one): nobody is
    waited on, and no cap holds the session."""
    return {"status": status, "waiting_on": [], "capped": False}


def write_state(store: Store, session_id: str, status: str, waiting_on: Iterable[str | None], *,
                capped: bool = False, from_starting: Iterable[str] = ("idle", "waiting")) -> Session | None:
    """Write ``status``, ``waiting_on`` and ``capped`` in one transaction, if the stored status allows it.

    A session that is ending, debriefing or finished is left alone; a starting one moves only to ``from_starting``
    (composer's run is starting until it first shows a turn or a question). ``waiting_on`` (each person once) and
    ``capped`` are kept only while waiting. Returns the stored session, or None when nothing was written.
    """
    with store.transaction():
        current = store.get_session(session_id)
        if current is None or current.status not in SETTLED:
            return None
        if current.status == "starting" and status not in tuple(from_starting):
            return None
        waiting = status == "waiting"
        who = list(dict.fromkeys(w for w in waiting_on if w)) if waiting else []
        held = capped and waiting
        if (current.status, current.waiting_on, current.capped) == (status, who, held):
            return current
        return store.update_session(session_id, status=status, waiting_on=who, capped=held)

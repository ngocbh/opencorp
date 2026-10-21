"""Session status writes that must not race the steps that finish a session."""

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

"""The office SQLite store: protocol entities, office bookkeeping, and the event outbox."""

from agent_corp.store.migrate import MigrationError, migrate
from agent_corp.store.store import (
    Store,
    new_id,
)

__all__ = [
    "MigrationError",
    "Store",
    "migrate",
    "new_id",
]

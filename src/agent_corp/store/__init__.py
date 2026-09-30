"""The office SQLite store: protocol entities, office bookkeeping, and the event outbox."""

from agent_corp.store.migrate import MigrationError, migrate
from agent_corp.store.store import (
    DuplicateKey,
    NotFound,
    StaleVersion,
    Store,
    StoreError,
    Tx,
    WorkedFolder,
    new_id,
)

__all__ = [
    "DuplicateKey",
    "MigrationError",
    "NotFound",
    "StaleVersion",
    "Store",
    "StoreError",
    "Tx",
    "WorkedFolder",
    "migrate",
    "new_id",
]

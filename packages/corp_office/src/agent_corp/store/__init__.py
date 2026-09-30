"""The office SQLite store: protocol entities, office bookkeeping, and the event outbox."""

from agent_corp.store.migrate import MigrationError, migrate
from agent_corp.store.store import (
    AuditEntry,
    DebriefRecord,
    DuplicateKey,
    InvalidTransition,
    NotFound,
    StaleVersion,
    Store,
    StoreError,
    Tx,
    UsageRecord,
    WorkedFolder,
    WorkerRecord,
    new_id,
)

__all__ = [
    "AuditEntry",
    "DebriefRecord",
    "DuplicateKey",
    "InvalidTransition",
    "MigrationError",
    "NotFound",
    "StaleVersion",
    "Store",
    "StoreError",
    "Tx",
    "UsageRecord",
    "WorkedFolder",
    "WorkerRecord",
    "migrate",
    "new_id",
]

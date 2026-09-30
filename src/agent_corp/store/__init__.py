"""The office SQLite store: protocol entities, office bookkeeping, and the event outbox."""

from agent_corp.store.migrate import MigrationError, migrate

__all__ = [
    "MigrationError",
    "migrate",
]

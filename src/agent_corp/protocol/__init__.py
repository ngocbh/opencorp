"""Protocol entities generated from packages/protocol/schema/protocol.schema.json."""

from datetime import UTC, datetime


def now() -> str:
    """Return the current UTC time as a protocol Timestamp, e.g. 2026-09-29T10:00:00.000Z."""
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")

"""Protocol entities generated from packages/protocol/schema/protocol.schema.json."""

from datetime import UTC, datetime


def stamp(at: datetime) -> str:
    """Return the aware time ``at`` as a protocol Timestamp in UTC, e.g. 2026-09-29T10:00:00.000Z."""
    return at.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def now() -> str:
    """Return the current UTC time as a protocol Timestamp, e.g. 2026-09-29T10:00:00.000Z."""
    return stamp(datetime.now(UTC))

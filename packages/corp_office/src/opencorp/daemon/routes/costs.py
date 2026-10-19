"""Spend per person since a time."""

from datetime import UTC, datetime

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from opencorp.daemon.http import HTTPError, call, get_office, ok


def utc_timestamp(raw: str | None) -> str:
    """``raw``, an ISO-8601 time with an offset, as a protocol Timestamp; ``HTTPError(422)`` otherwise."""
    try:
        at = datetime.fromisoformat(raw or "")
        utc = at.astimezone(UTC) if at.tzinfo is not None else None
    except (ValueError, OverflowError):  # OverflowError: a time near year 1 or 9999 shifted out of range
        utc = None
    if utc is None:
        raise HTTPError(422, "invalid_body", "since must be an ISO-8601 time with an offset, "
                                             "such as 2026-10-19T00:00:00.000Z")
    # The store compares times as strings, which is time order only in this one fixed-width UTC form.
    return utc.isoformat(timespec="milliseconds").replace("+00:00", "Z")


async def costs(request: Request) -> JSONResponse:
    """Spend per person since ``?since=``."""
    since = utc_timestamp(request.query_params.get("since"))
    return ok(await call(get_office(request).store.costs_since, since))


ROUTES = [Route("/costs", costs, methods=["GET"])]

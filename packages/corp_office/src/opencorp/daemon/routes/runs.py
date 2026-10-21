"""Run Logs routes: the list of runs, and one run's children. Read-only, on the office socket and HQ's /api
allowlist."""

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from opencorp.daemon.http import HTTPError, get_office, ok
from opencorp.daemon.routes.costs import utc_timestamp
from opencorp.runs.service import PAGE, RunLogs

RUN_STATUSES = ("running", "waiting", "idle", "finished", "failed", "interrupted")
MAX_LIMIT = 200


def run_logs(request: Request) -> RunLogs:
    """The office's Run Logs; ``501`` if this office has none."""
    found = get_office(request).extras.get("runs")
    if found is None:
        raise HTTPError(501, "not_implemented", f"{request.method} {request.url.path} is not implemented yet")
    return found


def int_param(raw: str | None, name: str, low: int, high: int, default: int) -> int:
    """Query parameter ``name`` as an integer from ``low`` to ``high`` (``default`` when absent); ``422`` otherwise."""
    if raw is None:
        return default
    # ASCII digits only: int() also takes signs, spaces, underscores and other scripts' digits.
    value = int(raw) if raw.isascii() and raw.isdigit() and len(raw) <= 9 else low - 1
    if not low <= value <= high:
        raise HTTPError(422, "invalid_body", f"{name} must be an integer from {low} to {high}")
    return value


def statuses(raw: str | None) -> list[str]:
    """``?status=``, a comma-separated list of run statuses (none when absent or empty); ``422`` on an unknown one."""
    if not raw:
        return []
    found = raw.split(",")
    for status in found:
        if status not in RUN_STATUSES:
            raise HTTPError(422, "invalid_body", f"status must be a comma-separated list of {', '.join(RUN_STATUSES)}")
    return found


def time_param(raw: str | None, name: str) -> str | None:
    """Query parameter ``name``, an ISO-8601 time with an offset, as a Timestamp (``None`` when absent or empty)."""
    return utc_timestamp(raw, name) if raw else None


async def list_runs(request: Request) -> JSONResponse:
    """Top-level runs, newest first, each with how many runs it started; ``?parent=<run_id>`` lists that run's
    children instead. Both filter by ``flow``, ``person``, ``status`` (any of a comma-separated list), ``q`` (any part
    of a run id) and launch time (``since`` inclusive, ``until`` exclusive), ``limit`` at a time after ``before``."""
    runs, q = run_logs(request), request.query_params
    filters = {"flow": q.get("flow") or None, "person": q.get("person") or None, "status": statuses(q.get("status")),
               "q": q.get("q") or None, "since": time_param(q.get("since"), "since"),
               "until": time_param(q.get("until"), "until"), "before": q.get("before") or None,
               "limit": int_param(q.get("limit"), "limit", 1, MAX_LIMIT, PAGE)}
    if parent := q.get("parent"):
        try:
            return ok(await runs.children(parent, **filters))
        except LookupError:
            raise HTTPError(404, "not_found", f"no run {parent}") from None
    return ok(await runs.page(**filters))


ROUTES = [Route("/runs", list_runs, methods=["GET"])]

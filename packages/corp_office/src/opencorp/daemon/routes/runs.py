"""Run Logs routes: the list of runs, one run's children, and one run's page (its header, node attempts, records, one
record and its log). Read-only, on the office socket and HQ's /api allowlist."""

from collections.abc import Awaitable, Callable
from typing import Any

from starlette.requests import Request
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

from opencorp.daemon.http import HTTPError, get_office, ok
from opencorp.daemon.routes.costs import utc_timestamp
from opencorp.runs.reader import UnreadableLog
from opencorp.runs.service import PAGE, Indexing, NoLog, RunLogs

RUN_STATUSES = ("running", "waiting", "idle", "finished", "failed", "interrupted")
MAX_LIMIT = 200
SEQ_MAX = 2**62


def run_logs(request: Request) -> RunLogs:
    """The office's Run Logs; ``501`` if this office has none."""
    found = get_office(request).extras.get("runs")
    if found is None:
        raise HTTPError(501, "not_implemented", f"{request.method} {request.url.path} is not implemented yet")
    return found


def int_param(raw: str | None, name: str, low: int, high: int, default: int | None) -> int | None:
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
    of a run id) and launch time (``since`` inclusive, ``until`` exclusive), or ``recent`` (open runs of any age and
    runs launched since then, the list's default), ``limit`` at a time after ``before``."""
    runs, q = run_logs(request), request.query_params
    filters = {"flow": q.get("flow") or None, "person": q.get("person") or None, "status": statuses(q.get("status")),
               "q": q.get("q") or None, "since": time_param(q.get("since"), "since"),
               "until": time_param(q.get("until"), "until"), "recent": time_param(q.get("recent"), "recent"),
               "before": q.get("before") or None,
               "limit": int_param(q.get("limit"), "limit", 1, MAX_LIMIT, PAGE)}
    if filters["recent"] and (filters["since"] or filters["until"]):
        raise HTTPError(422, "invalid_body", "recent can't be combined with since or until")
    if parent := q.get("parent"):
        try:
            return ok(await runs.children(parent, **filters))
        except LookupError:
            raise HTTPError(404, "not_found", f"no run {parent}") from None
    return ok(await runs.page(**filters))


async def _run_call(fn: Callable[..., Awaitable[Any]], *args: Any, **kwargs: Any) -> Any:
    """Await a run page read; its expected failures become ApiErrors (anything else is a 500, as it should be)."""
    try:
        return await fn(*args, **kwargs)
    except (NoLog, FileNotFoundError):
        raise HTTPError(404, "no_log", "this run has no log: it didn't start, or its log is gone") from None
    except LookupError as exc:
        raise HTTPError(404, "not_found", str(exc).strip("'")) from None
    except UnreadableLog as exc:  # an unknown or retired schema, a line that isn't a record, seqs out of order
        raise HTTPError(409, "unsupported_schema", str(exc)) from None
    except Indexing:
        raise HTTPError(503, "indexing", "the log is still being read; try again") from None


async def get_run(request: Request) -> JSONResponse:
    """One run's header: its summary, parent, children, fingerprint, pinned commit, models, usage and log state."""
    return ok(await _run_call(run_logs(request).detail, request.path_params["id"]))


async def run_nodes(request: Request) -> JSONResponse:
    """A run's node attempts, newest start first, ``limit`` (at most 1,000) at a time from ``before``."""
    q = request.query_params
    return ok(await _run_call(run_logs(request).nodes, request.path_params["id"],
                              before=int_param(q.get("before"), "before", 0, SEQ_MAX, None),
                              limit=int_param(q.get("limit"), "limit", 1, 1000, 1000)))


async def run_events(request: Request) -> JSONResponse:
    """A run's records after seq ``after``, evidence left out: at most ``limit`` (500) or 256 KiB."""
    q = request.query_params
    return ok(await _run_call(run_logs(request).events, request.path_params["id"],
                              after=int_param(q.get("after"), "after", 0, SEQ_MAX, None),
                              limit=int_param(q.get("limit"), "limit", 1, 500, 500)))


async def run_event(request: Request) -> JSONResponse:
    """One record of a run by seq, evidence included."""
    seq = int_param(request.path_params["seq"], "seq", 0, SEQ_MAX, 0)
    return ok(await _run_call(run_logs(request).event, request.path_params["id"], seq))


async def run_log(request: Request) -> StreamingResponse:
    """A run's whole log as stored, as a JSONL attachment no cache keeps."""
    run_id = request.path_params["id"]
    lines = await _run_call(run_logs(request).log_lines, run_id)
    # run_id is a stored run's id (the lookup above found it), so it is safe in the header.
    return StreamingResponse(lines, media_type="application/x-ndjson",
                             headers={"content-disposition": f'attachment; filename="{run_id}.jsonl"',
                                      "cache-control": "no-store"})


ROUTES = [
    Route("/runs", list_runs, methods=["GET"]),
    Route("/runs/{id}", get_run, methods=["GET"]),
    Route("/runs/{id}/nodes", run_nodes, methods=["GET"]),
    Route("/runs/{id}/events", run_events, methods=["GET"]),
    Route("/runs/{id}/events/{seq}", run_event, methods=["GET"]),
    Route("/runs/{id}/log", run_log, methods=["GET"]),
]

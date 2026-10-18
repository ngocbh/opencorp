"""Work-item routes."""

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from opencorp.daemon.http import HTTPError, call, get_office, ok
from opencorp.protocol.models import WorkItem


async def _item(request: Request) -> WorkItem:
    item_id = request.path_params["id"]
    item = await call(get_office(request).store.get_work_item, item_id)
    if item is None:
        raise HTTPError(404, "not_found", f"no work item {item_id}")
    return item


async def get_work_item(request: Request) -> JSONResponse:
    """One work item."""
    return ok(await _item(request))


async def list_comments(request: Request) -> JSONResponse:
    """A work item's comments, oldest first."""
    item = await _item(request)
    return ok(await call(get_office(request).store.list_comments, item.id))


ROUTES = [
    Route("/work-items/{id}", get_work_item, methods=["GET"]),
    Route("/work-items/{id}/comments", list_comments, methods=["GET"]),
]

"""Work-item routes."""

from starlette.routing import Route

from agent_corp.daemon.http import not_implemented

ROUTES = [
    Route("/work-items/{id}", not_implemented, methods=["GET"]),
    Route("/work-items/{id}/comments", not_implemented, methods=["GET"]),
]

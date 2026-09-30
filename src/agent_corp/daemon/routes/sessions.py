"""Session routes: listing, reading, transcripts, and session actions."""

from starlette.routing import Route

from agent_corp.daemon.http import not_implemented

ROUTES = [
    Route("/sessions", not_implemented, methods=["GET"]),
    Route("/sessions", not_implemented, methods=["POST"]),
    Route("/sessions/{id}", not_implemented, methods=["GET"]),
    Route("/sessions/{id}/messages", not_implemented, methods=["GET"]),
    Route("/sessions/{id}/prompt", not_implemented, methods=["POST"]),
    Route("/sessions/{id}/steer", not_implemented, methods=["POST"]),
    Route("/sessions/{id}/interrupt", not_implemented, methods=["POST"]),
    Route("/sessions/{id}/end", not_implemented, methods=["POST"]),
    Route("/sessions/{id}/cost-cap", not_implemented, methods=["POST"]),
]

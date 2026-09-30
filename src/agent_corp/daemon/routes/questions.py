"""Question routes: reading and answering questions, and question-card actions."""

from starlette.routing import Route

from agent_corp.daemon.http import not_implemented

ROUTES = [
    Route("/questions/{id}", not_implemented, methods=["GET"]),
    Route("/questions/{id}/answer", not_implemented, methods=["POST"]),
    Route("/questions/{id}/side", not_implemented, methods=["POST"]),
    Route("/questions/{id}/send-back", not_implemented, methods=["POST"]),
    Route("/questions/{id}/stop", not_implemented, methods=["POST"]),
]

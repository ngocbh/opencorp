"""Learning routes: profile manager, profile proposals, feedback, and debriefs."""

from starlette.routing import Route

from agent_corp.daemon.http import not_implemented

ROUTES = [
    Route("/profiles/{person}/manager", not_implemented, methods=["POST"]),
    Route("/profiles/{person}/proposals", not_implemented, methods=["GET"]),
    Route("/profile-proposals/{id}/apply", not_implemented, methods=["POST"]),
    Route("/feedback", not_implemented, methods=["POST"]),
    Route("/debriefs/{session}", not_implemented, methods=["GET"]),
    Route("/debriefs/{session}/confirm", not_implemented, methods=["POST"]),
]

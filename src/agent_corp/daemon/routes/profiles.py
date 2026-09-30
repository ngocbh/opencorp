"""Profile routes: read and edit a person's profile.md."""

from starlette.routing import Route

from agent_corp.daemon.http import not_implemented

ROUTES = [
    Route("/profiles/{person}", not_implemented, methods=["GET"]),
    Route("/profiles/{person}", not_implemented, methods=["PUT"]),
]

"""People routes: the roster and who worked in a folder."""

from starlette.routing import Route

from agent_corp.daemon.http import not_implemented

ROUTES = [
    Route("/people", not_implemented, methods=["GET"]),
    Route("/people", not_implemented, methods=["POST"]),
    Route("/folders/{cwd:path}/people", not_implemented, methods=["GET"]),
]

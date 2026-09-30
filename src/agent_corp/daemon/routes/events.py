"""The event stream."""

from starlette.routing import Route

from agent_corp.daemon.http import not_implemented

ROUTES = [Route("/events", not_implemented, methods=["GET"])]

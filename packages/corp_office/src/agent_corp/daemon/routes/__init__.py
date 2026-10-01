"""The office's routes, one module per area."""

from starlette.routing import BaseRoute

from agent_corp.daemon.routes import devices, events, learning, people, profiles, questions, sessions, work_items


def all_routes() -> list[BaseRoute]:
    """Every route the office serves."""
    return [*people.ROUTES, *sessions.ROUTES, *work_items.ROUTES, *questions.ROUTES,
            *profiles.ROUTES, *learning.ROUTES, *events.ROUTES, *devices.ROUTES]

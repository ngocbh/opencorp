"""The HQ app each HQ listener serves: the /api allowlist and the built web app."""

from __future__ import annotations

from typing import TYPE_CHECKING

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route
from starlette.types import ASGIApp

from opencorp.daemon.http import EXCEPTION_HANDLERS, error, ok
from opencorp.hq.guard import HqGuard
from opencorp.hq.static import serve_app

if TYPE_CHECKING:
    from opencorp.daemon.app import Office
    from opencorp.hq.core import Hq

ANY = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]


def get_hq(request: Request) -> Hq:
    """The Hq this app serves."""
    return request.app.state.hq


async def health(request: Request) -> JSONResponse:
    """The office's compatibility key and the built app's. Open without a session."""
    return ok(get_hq(request).health())


async def no_route(request: Request) -> JSONResponse:
    """Everything under /api that isn't on the allowlist."""
    return error(404, "no_route", f"no route {request.method} {request.url.path}")


def create_hq_app(office: Office, hq: Hq, *, port: int | None) -> ASGIApp:
    """The app one HQ listener serves: ``port`` is the TCP listener's bound port, None for ``hq.sock``.

    It never mounts the socket's routes, and the socket's app never mounts these, so routing fails closed.
    """
    api = [
        Route("/health", health, methods=["GET"]),
        Route("/{rest:path}", no_route, methods=ANY),
    ]
    app = Starlette(
        routes=[Route("/api", no_route, methods=ANY), Mount("/api", routes=api),
                Route("/{path:path}", serve_app, methods=["GET"])],
        exception_handlers=EXCEPTION_HANDLERS,
    )
    app.state.office = office
    app.state.hq = hq
    # Outside Starlette, so its ServerErrorMiddleware's 500s pass through the guard and carry the headers too.
    return HqGuard(app, port=port, dev_origins=hq.config.dev_origins)

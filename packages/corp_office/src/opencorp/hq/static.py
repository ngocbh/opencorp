"""The built web app, served from ``app_dir``."""

from starlette.requests import Request
from starlette.responses import PlainTextResponse, Response


async def serve_app(request: Request) -> Response:
    """A file of the built app."""
    return PlainTextResponse("not found", 404)

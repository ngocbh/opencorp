"""The guard on every HQ request, before routing."""

from collections.abc import Iterable
from typing import Any

from starlette.types import ASGIApp, Receive, Scope, Send


class HqGuard:
    """Pure ASGI middleware run on every HQ request."""

    def __init__(self, app: ASGIApp, *, port: int | None, dev_origins: Iterable[str] = ()) -> None:
        self.app = app
        self.port = port
        self.dev_origins = frozenset(dev_origins)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> Any:
        await self.app(scope, receive, send)

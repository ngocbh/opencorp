"""The office object, its paths, and the Starlette app."""

import asyncio
import inspect
import logging
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit

from agent_composer.memory.storage.markdown import MarkdownStore
from starlette.applications import Starlette
from starlette.middleware import Middleware

from agent_corp.company.git import CompanyGit
from agent_corp.daemon.auth import DeviceTokens
from agent_corp.daemon.bus import Bus
from agent_corp.daemon.http import EXCEPTION_HANDLERS
from agent_corp.daemon.routes import all_routes
from agent_corp.store import Store

log = logging.getLogger(__name__)


class OfficePaths:
    """Where the office keeps its files under an agent-corp home."""

    def __init__(self, home: Path) -> None:
        self.home = home
        self.company = home / "company"
        self.office = home / "office"
        self.store = self.office / "store.sqlite"
        self.socket = self.office / "office.sock"
        self.pidfile = self.office / "office.pid"
        self.worktrees = self.office / "worktrees"
        self.runs = self.office / "runs"
        self.memory = self.office / "memory"
        self.secrets = self.office / "secrets"

    def run_dir(self, session_id: str) -> Path:
        """The directory a session's worker runs in."""
        return self.runs / session_id


class WorkerPool(Protocol):
    """The worker registry, as the office sees it."""

    def close_all(self) -> None:
        """Stop every worker."""


async def _maybe_await(value: Any) -> None:
    if inspect.isawaitable(value):
        await value


@dataclass
class Office:
    """Everything the routes and extensions share: store, company git, bus, and hooks."""

    paths: OfficePaths
    store: Store
    git: CompanyGit
    bus: Bus
    workers: WorkerPool | None = None
    profile_store: Callable[[str], MarkdownStore] | None = None
    on_start: list[Callable[[], Any]] = field(default_factory=list)
    on_stop: list[Callable[[], Any]] = field(default_factory=list)
    extras: dict[str, Any] = field(default_factory=dict)
    _unlisten: Callable[[], None] | None = field(default=None, init=False, repr=False)

    async def start(self) -> None:
        """Attach the bus to the running loop, feed it store events, and run ``on_start``.

        If anything fails, ``stop`` runs before the error propagates, so what earlier
        callbacks started (threads, workers) is shut down.
        """
        try:
            self.bus.attach(asyncio.get_running_loop())
            self._unlisten = self.store.add_listener(self.bus.publish_meta)
            for callback in self.on_start:
                await _maybe_await(callback())
        except BaseException:
            await self.stop()
            raise

    async def stop(self) -> None:
        """End SSE streams, stop the workers, and run ``on_stop`` in reverse order.

        Every ``on_stop`` callback runs: one that raises is logged and the rest still run.
        ``stop`` also runs after a failed ``start``, so an ``on_stop`` callback must cope with
        its ``on_start`` never having run.
        """
        self.bus.close()
        if self._unlisten is not None:
            self._unlisten()
            self._unlisten = None
        if self.workers is not None:
            await asyncio.to_thread(self.workers.close_all)
        for callback in reversed(self.on_stop):
            try:
                await _maybe_await(callback())
            except Exception:
                log.exception("office on_stop callback %r failed", callback)


class AbsoluteFormPaths:
    """Rewrite an absolute-form request target (``http://host/path``) to its path.

    Bun's fetch sends one over a unix socket when ``HTTP_PROXY`` is set.
    """

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] == "http" and not scope["path"].startswith("/"):
            raw = scope.get("raw_path") or scope["path"].encode("latin-1")
            scope = {**scope, "path": urlsplit(scope["path"]).path or "/",
                     "raw_path": urlsplit(raw.decode("latin-1")).path.encode("latin-1") or b"/"}
        await self.app(scope, receive, send)


def create_app(office: Office) -> Starlette:
    """The office's Starlette app; its lifespan starts and stops ``office``."""

    @asynccontextmanager
    async def lifespan(app: Starlette):
        await office.start()
        try:
            yield
        finally:
            await office.stop()

    app = Starlette(routes=all_routes(), exception_handlers=EXCEPTION_HANDLERS,
                    middleware=[Middleware(AbsoluteFormPaths), Middleware(DeviceTokens, office=office)],
                    lifespan=lifespan)
    app.state.office = office
    return app

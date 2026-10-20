"""The Hq object: HQ's settings, ids and shared state, attached to an office."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from opencorp.company.snapshot import CompanySnapshots
from opencorp.company.source import CompanySource
from opencorp.hq.config import HqConfig, load_config
from opencorp.hq.login import Logins
from opencorp.hq.pairing import PairCodes
from opencorp.hq.servers import Listeners
from opencorp.hq.sessions import BrowserSessions
from opencorp.hq.status import other_users
from opencorp.hq.version import BuildInfo, office_api
from opencorp.protocol import now, stamp
from opencorp.protocol.models import ApiVersion, Health, HqStatus, HqTcp, PairCode

if TYPE_CHECKING:
    from opencorp.daemon.app import Office


@dataclass
class Hq:
    """What HQ's listeners, routes and socket routes share for one office."""

    office: Office
    config: HqConfig
    api: str
    build: BuildInfo
    snapshots: CompanySnapshots
    sessions: BrowserSessions
    codes: PairCodes
    logins: Logins
    source: CompanySource
    """The Source view's trees and files."""
    listen: bool = False
    """Whether starting HQ starts its listeners (the daemon); tests attach without them."""
    bound_port: int | None = None
    """The TCP listener's port while it listens."""
    tcp_error: str | None = None
    next_retry_at: str | None = None
    socket_error: str | None = None
    """Why hq.sock isn't listening, when binding it failed."""
    listeners: Listeners | None = None

    @classmethod
    def create(cls, office: Office) -> Hq:
        """HQ for ``office``, with the settings in its ``hq.json``, sharing its company snapshot cache (made and
        registered in ``office.extras`` when it has none)."""
        config = load_config(office.paths.office)
        snapshots = office.extras.setdefault("company", CompanySnapshots(office.git))
        sessions = BrowserSessions(office.store, snapshots)
        return cls(office=office, config=config, api=office_api(), build=BuildInfo(config.app_dir),
                   snapshots=snapshots, sessions=sessions, codes=PairCodes(office.paths.office),
                   logins=Logins(sessions), source=CompanySource(office.git))

    @property
    def socket(self) -> Path:
        """The path of hq.sock."""
        return self.office.paths.office / "hq.sock"

    def url(self, path: str = "/") -> str | None:
        """``http://127.0.0.1:<port><path>`` while TCP is listening, else None."""
        return None if self.bound_port is None else f"http://127.0.0.1:{self.bound_port}{path}"

    def health(self) -> Health:
        """``GET /api/health``: the office's key and the built app's, if there is one."""
        return Health(ok=True, office=ApiVersion(api=self.api), app=self.build.read())

    async def mint(self, handle: str, *, issuer: str, open_file: bool) -> PairCode:
        """A one-time link for ``handle``, asked for by ``issuer``."""
        minted = await self.codes.mint(handle, issuer=issuer, url=lambda code: self.url(f"/pair#{code}"),
                                 open_file=open_file)
        return PairCode(path=f"/pair#{minted.code}", url=self.url(f"/pair#{minted.code}"), socket=str(self.socket),
                        port=self.bound_port or self.config.port, expires_at=stamp(minted.expires_at),
                        open_file=None if minted.file is None else str(minted.file))

    def status(self) -> HqStatus:
        """Where HQ listens now, for ``opencorp pair`` and ``opencorp doctor``."""
        return HqStatus(socket=str(self.socket),
                        tcp=HqTcp(enabled=self.config.tcp, port=self.bound_port or self.config.port,
                                  listening=self.bound_port is not None, error=self.tcp_error,
                                  next_retry_at=self.next_retry_at),
                        url=self.url(), health=self.health(), socket_error=self.socket_error,
                        warnings=self.warnings())

    def warnings(self) -> list[str]:
        """What ``opencorp doctor`` and ``opencorp pair`` should mention, besides ``socket_error`` and TCP's own
        state."""
        found = [] if self.config.problem is None else [f"settings ignored: {self.config.problem}"]
        if self.config.tcp and (others := other_users()):
            found.append(f"the web port is on and this host has other users ({', '.join(others)}): any of them could "
                         f"take the port while the office is down. Turn it off with \"tcp\": false in "
                         f"{self.office.paths.office / 'hq.json'}")
        return found

    async def start(self) -> None:
        """Delete expired browser sessions and the redirect files a crash left, then start the listeners if
        ``listen``."""
        await asyncio.to_thread(self.office.store.prune_hq_sessions, now())
        await asyncio.to_thread(self.codes.remove_leftovers)
        if self.listen:
            self.listeners = Listeners(self)
            await self.listeners.start()

    async def stop(self) -> None:
        """Stop the listeners, forget pending codes and delete their redirect files."""
        try:
            if self.listeners is not None:
                listeners, self.listeners = self.listeners, None
                await listeners.stop()
        finally:
            self.codes.close()


def attach(office: Office, *, listen: bool = True) -> Hq:
    """Attach HQ to ``office`` as ``extras["hq"]``: attached last, it starts after everything else and stops first.

    ``listen`` starts the listeners on start (the daemon); tests attach without them.
    """
    hq = Hq.create(office)
    hq.listen = listen
    office.extras["hq"] = hq
    office.on_start.append(hq.start)
    office.on_stop.append(hq.stop)
    return hq

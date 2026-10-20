"""The Hq object: HQ's settings, ids and shared state, attached to an office."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from opencorp.company.snapshot import CompanySnapshots
from opencorp.hq.config import HqConfig, load_config
from opencorp.hq.pairing import PairCodes
from opencorp.hq.sessions import BrowserSessions
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
    listen: bool = False
    """Whether starting HQ starts its listeners (the daemon); tests attach without them."""
    bound_port: int | None = None
    """The TCP listener's port while it listens."""
    tcp_error: str | None = None
    next_retry_at: str | None = None

    @classmethod
    def create(cls, office: Office) -> Hq:
        """HQ for ``office``, with the settings in its ``hq.json``, sharing its company snapshot cache (made and
        registered in ``office.extras`` when it has none)."""
        config = load_config(office.paths.office)
        snapshots = office.extras.setdefault("company", CompanySnapshots(office.git))
        return cls(office=office, config=config, api=office_api(), build=BuildInfo(config.app_dir),
                   snapshots=snapshots, sessions=BrowserSessions(office.store, snapshots),
                   codes=PairCodes(office.paths.office))

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

    def mint(self, handle: str, *, issuer: str, open_file: bool) -> PairCode:
        """A one-time link for ``handle``, asked for by ``issuer``."""
        minted = self.codes.mint(handle, issuer=issuer, url=lambda code: self.url(f"/pair#{code}"),
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
                        url=self.url(), health=self.health(), warnings=self.warnings())

    def warnings(self) -> list[str]:
        """What ``opencorp doctor`` and ``opencorp pair`` should mention."""
        return [] if self.config.problem is None else [f"settings ignored: {self.config.problem}"]

    async def start(self) -> None:
        """Delete expired browser sessions and the redirect files a crash left."""
        await asyncio.to_thread(self.office.store.prune_hq_sessions, now())
        await asyncio.to_thread(self.codes.remove_leftovers)

    async def stop(self) -> None:
        """Forget pending codes and delete their redirect files."""
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

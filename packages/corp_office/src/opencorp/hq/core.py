"""The Hq object: HQ's settings, ids and shared state, attached to an office."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from opencorp.company.snapshot import CompanySnapshots
from opencorp.hq.config import HqConfig, load_config
from opencorp.hq.version import BuildInfo, office_api
from opencorp.protocol.models import ApiVersion, Health

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

    @classmethod
    def create(cls, office: Office) -> Hq:
        """HQ for ``office``, with the settings in its ``hq.json``, sharing its company snapshot cache (made and
        registered in ``office.extras`` when it has none)."""
        config = load_config(office.paths.office)
        snapshots = office.extras.setdefault("company", CompanySnapshots(office.git))
        return cls(office=office, config=config, api=office_api(), build=BuildInfo(config.app_dir),
                   snapshots=snapshots)

    def health(self) -> Health:
        """``GET /api/health``: the office's key and the built app's, if there is one."""
        return Health(ok=True, office=ApiVersion(api=self.api), app=self.build.read())

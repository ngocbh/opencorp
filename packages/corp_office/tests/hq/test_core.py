"""The Hq object an office carries."""

import json

from opencorp.company.snapshot import CompanySnapshots
from opencorp.hq.core import Hq
from opencorp.hq.version import office_api
from tests.daemon.conftest import _isolate_git, company, office, profile_stores  # noqa: F401


def test_hq_reads_its_settings_and_reports_health(office, tmp_path):
    office.paths.office.mkdir(parents=True, exist_ok=True)
    (tmp_path / "dist").mkdir()
    (tmp_path / "dist" / "build.json").write_text(json.dumps({"build": "b1", "api": "x"}))
    (office.paths.office / "hq.json").write_text(json.dumps({"tcp": False, "app_dir": str(tmp_path / "dist")}))
    hq = Hq.create(office)
    assert hq.config.tcp is False and isinstance(hq.snapshots, CompanySnapshots)
    health = hq.health()
    assert health.ok is True and health.office.api == office_api() and health.app.build == "b1"


def test_hq_shares_the_offices_snapshot_cache(office):
    cache = office.extras["company"] = CompanySnapshots(office.git)
    assert Hq.create(office).snapshots is cache


def test_hq_registers_the_snapshot_cache_it_creates(office):
    assert "company" not in office.extras
    hq = Hq.create(office)
    assert office.extras["company"] is hq.snapshots

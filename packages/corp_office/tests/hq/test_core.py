"""The Hq object an office carries."""

import dataclasses
import json

import pytest

from opencorp.company.snapshot import CompanySnapshots
from opencorp.hq.core import Hq, attach
from opencorp.hq.servers import Listeners
from opencorp.hq.version import office_api
from tests.daemon.conftest import _isolate_git, company, office, profile_stores, short_dir  # noqa: F401
from tests.store.test_hq_sessions import record


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


async def test_attach_puts_hq_on_the_office_and_prunes_expired_sessions_at_start(office):
    office.store.add_hq_session(record(expires_at="2026-01-01T00:00:00.000Z"))
    hq = attach(office, listen=False)
    assert office.extras["hq"] is hq and hq.listen is False
    await office.start()
    try:
        assert office.store.list_hq_sessions() == []
    finally:
        await office.stop()


async def test_mint_without_tcp_has_no_url_or_file(office):
    hq = attach(office, listen=False)
    code = await hq.mint("ngocbh", issuer="ngocbh", open_file=True)
    assert code.url is None and code.open_file is None and code.path.startswith("/pair#")
    assert code.socket == str(office.paths.office / "hq.sock") and code.port == hq.config.port
    assert hq.codes.redeem(code.path.split("#")[1]).handle == "ngocbh"


async def test_mint_while_listening_writes_a_file_that_stopping_deletes(office):
    office.paths.office.mkdir(mode=0o700, parents=True, exist_ok=True)
    hq = attach(office, listen=False)
    hq.bound_port = 49999
    await office.start()
    try:
        code = await hq.mint("ngocbh", issuer="ngocbh", open_file=True)
        assert code.url == f"http://127.0.0.1:49999{code.path}" and code.port == 49999
        assert code.url in (office.paths.office / code.open_file).read_text()
    finally:
        await office.stop()
    assert not (office.paths.office / code.open_file).exists()


async def test_status_before_listening(office):
    status = attach(office, listen=False).status()
    assert status.url is None and status.tcp.listening is False and status.health.office.api
    assert status.socket == str(office.paths.office / "hq.sock")


async def test_status_names_ignored_settings(office):
    office.paths.office.mkdir(parents=True, exist_ok=True)
    (office.paths.office / "hq.json").write_text("{")
    assert attach(office, listen=False).status().warnings[0].startswith("settings ignored: ")


async def test_start_deletes_redirect_files_a_crash_left(office):
    office.paths.office.mkdir(mode=0o700, parents=True, exist_ok=True)
    left = [office.paths.office / "pair-0123456789abcdef.html", office.paths.office / ".pair-0a.html.123.tmp"]
    kept = office.paths.office / "hq.json"
    for path in left:
        path.write_text("x")
    kept.write_text("{}")
    attach(office, listen=False)
    await office.start()
    try:
        assert not any(path.exists() for path in left) and kept.exists()
    finally:
        await office.stop()


async def test_status_warns_when_tcp_is_on_and_others_use_the_host(office, monkeypatch):
    monkeypatch.setattr("opencorp.hq.core.other_users", lambda: ["ann"])
    hq = attach(office, listen=False)
    hq.config = dataclasses.replace(hq.config, tcp=True)
    assert any("other users (ann)" in w for w in hq.status().warnings)
    hq.config = dataclasses.replace(hq.config, tcp=False)
    assert hq.status().warnings == []


async def test_a_listening_hq_starts_and_stops_its_listeners_with_the_office(office, short_dir, monkeypatch):
    monkeypatch.setattr(office.paths, "office", short_dir)
    (short_dir / "hq.json").write_text(json.dumps({"tcp": False}))
    hq = attach(office)
    await office.start()
    try:
        assert hq.listeners is not None and hq.socket.exists()
    finally:
        await office.stop()
    assert not hq.socket.exists()


async def test_stop_forgets_the_codes_even_when_the_listeners_fail_to_stop(office, short_dir, monkeypatch):
    monkeypatch.setattr(office.paths, "office", short_dir)
    (short_dir / "hq.json").write_text(json.dumps({"tcp": False}))
    hq = attach(office)
    await office.start()
    await hq.mint("ngocbh", issuer="ngocbh", open_file=False)

    async def broken():
        raise RuntimeError("boom")

    listeners = hq.listeners
    monkeypatch.setattr(listeners, "stop", broken)
    with pytest.raises(RuntimeError):
        await hq.stop()
    assert hq.codes._pending == {}
    await Listeners.stop(listeners)
    await office.stop()

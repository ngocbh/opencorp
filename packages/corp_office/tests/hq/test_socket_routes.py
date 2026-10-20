"""HQ's routes on office.sock: status, minting links, and browser sessions."""

import logging

import httpx
import pytest

from opencorp.auth.tokens import new_token
from opencorp.daemon.app import create_app
from tests.daemon.test_auth import add_human, bearer, give_device


@pytest.fixture
async def sock(office, hq):
    """A client of the office socket's own app, with HQ attached."""
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(office)), base_url="http://localhost") as c:
        yield c


async def test_no_device_mode_pairs_as_the_ceo_and_stays_unenforced(sock, hq):
    r = await sock.post("/hq/pair", json={})
    assert r.status_code == 200 and r.json()["path"].startswith("/pair#") and r.json()["url"] is None
    assert hq.codes.redeem(r.json()["path"].split("#")[1]).issuer == "ngocbh"
    assert (await sock.get("/whoami")).json() == {"person": "ngocbh", "device": None}  # still no token needed


async def test_pairing_never_logs_the_code(sock, caplog):
    caplog.set_level(logging.DEBUG)
    code = (await sock.post("/hq/pair", json={"open_file": True})).json()["path"].split("#")[1]
    assert code not in caplog.text


async def test_the_handle_must_be_a_known_human(sock):
    assert (await sock.post("/hq/pair", json={"handle": "minh"})).json()["error"] == "not_a_human"
    assert (await sock.post("/hq/pair", json={"handle": "nobody"})).status_code == 404


async def test_only_the_person_or_the_ceo_may_pair_for_them(sock, company, hq):
    add_human(company, "ann")
    ceo, ann = new_token(), new_token()
    give_device(company, "ngocbh", "mac", ceo)
    give_device(company, "ann", "laptop", ann)
    assert (await sock.post("/hq/pair", json={})).status_code == 401
    assert (await sock.post("/hq/pair", json={"handle": "ngocbh"}, headers=bearer(ann))).status_code == 403
    r = await sock.post("/hq/pair", json={"handle": "ann"}, headers=bearer(ceo))
    assert r.status_code == 200
    assert (hq.codes.redeem(r.json()["path"].split("#")[1]).handle,) == ("ann",)
    assert (await sock.post("/hq/pair", json={}, headers=bearer(ann))).status_code == 200


async def test_browsers_are_listed_and_removed_by_their_person_or_the_ceo(sock, hq, company):
    add_human(company, "ann")
    ceo, ann = new_token(), new_token()
    give_device(company, "ngocbh", "mac", ceo)
    give_device(company, "ann", "laptop", ann)
    mine, cookie = await hq.sessions.issue("ann", issued_by="ngocbh", label="Firefox")
    listed = (await sock.get("/hq/browsers", headers=bearer(ann))).json()
    assert [(b["id"], b["issued_by"], b["label"]) for b in listed] == [(mine.id, "ngocbh", "Firefox")]
    assert "secret_sha256" not in listed[0] and "password_fp" not in listed[0]
    assert (await sock.get("/hq/browsers", params={"person": "ngocbh"}, headers=bearer(ann))).status_code == 403
    assert (await sock.get("/hq/browsers", params={"person": "ann"}, headers=bearer(ceo))).status_code == 200
    theirs, _ = await hq.sessions.issue("ngocbh", issued_by="ngocbh", label=None)
    assert (await sock.delete(f"/hq/browsers/{theirs.id}", headers=bearer(ann))).status_code == 403
    assert (await sock.delete(f"/hq/browsers/{mine.id}", headers=bearer(ann))).json() == {"ok": True}
    assert await hq.sessions.check(cookie) is None
    assert (await sock.delete(f"/hq/browsers/{mine.id}", headers=bearer(ceo))).status_code == 404
    assert (await sock.delete(f"/hq/browsers/{theirs.id}", headers=bearer(ceo))).json() == {"ok": True}


async def test_status(sock, hq):
    r = await sock.get("/hq")
    assert r.status_code == 200 and r.json()["socket"].endswith("hq.sock") and r.json()["tcp"]["enabled"] is False
    assert r.json()["health"]["office"]["api"] == hq.api


async def test_without_hq_the_routes_are_501(office):
    office.extras.pop("hq", None)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(office)), base_url="http://localhost") as c:
        assert (await c.get("/hq")).status_code == 501
        assert (await c.post("/hq/pair", json={})).status_code == 501


async def test_get_hq_reports_off_retrying_and_listening(sock, hq):
    assert (await sock.get("/hq")).json()["tcp"]["listening"] is False
    hq.tcp_error, hq.next_retry_at = "Address already in use", "2026-10-19T10:00:05.000Z"
    body = (await sock.get("/hq")).json()
    assert body["tcp"]["error"] == "Address already in use" and body["url"] is None
    hq.tcp_error = hq.next_retry_at = None
    hq.bound_port = 49999
    body = (await sock.get("/hq")).json()
    assert body["tcp"] == {"enabled": False, "port": 49999, "listening": True, "error": None, "next_retry_at": None}
    assert body["url"] == "http://127.0.0.1:49999/"

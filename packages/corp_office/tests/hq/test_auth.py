"""The browser-session cookie on HQ's /api: never the no-device fallback, never a Bearer token."""

import logging

import pytest

from opencorp.auth.tokens import new_token
from tests.hq.conftest import PORT, hq_client


async def test_without_a_cookie_api_is_401_even_with_no_devices(web):
    r = await web.get("/api/whoami")
    assert r.status_code == 401 and r.json()["error"] == "sign_in_required" and "opencorp pair" in r.json()["message"]
    assert "content-security-policy" in r.headers


async def test_health_and_the_app_stay_open(web):
    assert (await web.get("/api/health")).status_code == 200
    assert (await web.get("/", headers={"sec-fetch-dest": "document"})).status_code != 401


async def test_a_bearer_token_is_ignored(web):
    assert (await web.get("/api/whoami", headers={"authorization": f"Bearer {new_token()}"})).status_code == 401


async def test_a_valid_cookie_acts_as_its_person(web, hq):
    public, cookie = await hq.sessions.issue("ngocbh", issued_by="ngocbh", label=None)
    web.cookies.set(f"opencorp_hq_{PORT}", cookie, domain="127.0.0.1")
    assert (await web.get("/api/whoami")).json() == {"person": "ngocbh", "device": public.name}


async def test_a_cookie_named_for_another_port_doesnt_count(web, hq):
    _, cookie = await hq.sessions.issue("ngocbh", issued_by="ngocbh", label=None)
    web.cookies.set("opencorp_hq_1", cookie, domain="127.0.0.1")
    assert (await web.get("/api/whoami")).status_code == 401


async def test_on_hq_sock_the_cookie_is_named_for_the_forwarded_port(office, hq):
    _, cookie = await hq.sessions.issue("ngocbh", issued_by="ngocbh", label=None)
    async with hq_client(office, hq, port=None, host="127.0.0.1:5555", cookie=f"opencorp_hq_5555={cookie}") as c:
        assert (await c.get("/api/whoami")).json()["person"] == "ngocbh"


async def pair(web, hq, label="Safari on Mac"):
    code = (await hq.mint("ngocbh", issuer="ngocbh", open_file=False)).path.split("#")[1]
    return await web.post("/api/pair", json={"code": code, "label": label})


async def test_pairing_sets_a_strict_http_only_cookie_and_returns_the_session(web, hq):
    r = await pair(web, hq)
    assert r.status_code == 200 and r.json()["person"] == "ngocbh" and r.json()["label"] == "Safari on Mac"
    assert r.json()["issued_by"] == "ngocbh" and "secret_sha256" not in r.json()
    cookie = r.headers["set-cookie"]
    assert cookie.startswith(f"opencorp_hq_{PORT}=") and "HttpOnly" in cookie and "SameSite=Strict" in cookie
    assert "Path=/" in cookie and "Max-Age=2592000" in cookie and "Secure" not in cookie
    assert (await web.get("/api/whoami")).json()["person"] == "ngocbh"


async def test_a_used_or_wrong_code_says_to_pair_again(web, hq):
    code = (await hq.mint("ngocbh", issuer="ngocbh", open_file=False)).path.split("#")[1]
    assert (await web.post("/api/pair", json={"code": code})).status_code == 200
    for bad in (code, "nonsense"):
        r = await web.post("/api/pair", json={"code": bad})
        assert r.status_code == 400 and r.json()["error"] == "pair_code_invalid" and "opencorp pair" in r.json()["message"]
        assert bad not in r.text


async def test_pairing_never_logs_the_code_or_the_cookie(web, hq, caplog):
    caplog.set_level(logging.DEBUG)
    code = (await hq.mint("ngocbh", issuer="ngocbh", open_file=False)).path.split("#")[1]
    r = await web.post("/api/pair", json={"code": code})
    secret = r.headers["set-cookie"].split("=", 1)[1].split(";")[0].split(".")[1]
    assert code not in caplog.text and secret not in caplog.text


async def test_pairing_again_in_the_same_browser_revokes_the_old_session(web, hq, office):
    first = (await pair(web, hq)).json()["id"]
    second = (await pair(web, hq)).json()["id"]
    assert office.store.get_hq_session(first) is None and office.store.get_hq_session(second) is not None


async def test_pairing_with_a_cookie_that_proves_nothing_revokes_nothing(web, hq, office):
    other, _ = await hq.sessions.issue("ngocbh", issued_by="ngocbh", label=None)
    web.cookies.set(f"opencorp_hq_{PORT}", f"{other.id}.forged", domain="127.0.0.1")
    assert (await pair(web, hq)).status_code == 200
    assert office.store.get_hq_session(other.id) is not None


async def test_logout_ends_the_session_and_clears_the_cookie(web, hq, office):
    sid = (await pair(web, hq)).json()["id"]
    r = await web.post("/api/logout", json={})
    assert r.json() == {"ok": True} and "Max-Age=0" in r.headers["set-cookie"]
    assert office.store.get_hq_session(sid) is None and (await web.get("/api/whoami")).status_code == 401


async def test_logout_needs_a_session(web):
    assert (await web.post("/api/logout", json={})).status_code == 401


async def test_a_failing_check_of_the_old_cookie_doesnt_burn_the_code(web, hq, monkeypatch):
    code = (await hq.mint("ngocbh", issuer="ngocbh", open_file=False)).path.split("#")[1]

    async def broken(cookie):
        raise RuntimeError("git went away")

    with monkeypatch.context() as m:
        m.setattr(hq.sessions, "check", broken)
        with pytest.raises(RuntimeError):
            await web.post("/api/pair", json={"code": code})
    assert (await web.post("/api/pair", json={"code": code})).status_code == 200

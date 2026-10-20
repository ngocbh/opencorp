"""The browser-session cookie on HQ's /api: never the no-device fallback, never a Bearer token."""

from opencorp.auth.tokens import new_token
from tests.hq.conftest import hq_client


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
    web.cookies.set("opencorp_hq_49380", cookie, domain="127.0.0.1")
    assert (await web.get("/api/whoami")).json() == {"person": "ngocbh", "device": public.name}


async def test_a_cookie_named_for_another_port_doesnt_count(web, hq):
    _, cookie = await hq.sessions.issue("ngocbh", issued_by="ngocbh", label=None)
    web.cookies.set("opencorp_hq_1", cookie, domain="127.0.0.1")
    assert (await web.get("/api/whoami")).status_code == 401


async def test_on_hq_sock_the_cookie_is_named_for_the_forwarded_port(office, hq):
    _, cookie = await hq.sessions.issue("ngocbh", issued_by="ngocbh", label=None)
    async with hq_client(office, hq, port=None, host="127.0.0.1:5555", cookie=f"opencorp_hq_5555={cookie}") as c:
        assert (await c.get("/api/whoami")).json()["person"] == "ngocbh"

"""HQ's /api: the allowlist."""

from tests.hq.conftest import PORT


async def test_health_is_open_and_says_both_keys(web, hq, dist):
    r = await web.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "office": {"api": hq.api}, "app": {"build": "b1", "api": "x"}}


async def test_anything_else_under_api_needs_a_session_first(web):
    r = await web.get("/api/people")
    assert (r.status_code, r.json()["error"]) == (401, "sign_in_required")


async def test_anything_else_under_api_is_a_json_404(web, hq):
    _, cookie = await hq.sessions.issue("ngocbh", issued_by="ngocbh", label=None)
    web.cookies.set(f"opencorp_hq_{PORT}", cookie, domain="127.0.0.1")
    for path in ("/api", "/api/people", "/api/hq/pair", "/api/hq/browsers"):
        r = await web.get(path)
        assert (r.status_code, r.json()["error"]) == (404, "no_route"), path

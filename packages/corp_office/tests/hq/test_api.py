"""HQ's /api: the allowlist."""


async def test_health_is_open_and_says_both_keys(web, hq, dist):
    r = await web.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "office": {"api": hq.api}, "app": {"build": "b1", "api": "x"}}


async def test_anything_else_under_api_is_a_json_404(web):
    for path in ("/api", "/api/people", "/api/hq/pair"):
        r = await web.get(path)
        assert (r.status_code, r.json()["error"]) == (404, "no_route"), path

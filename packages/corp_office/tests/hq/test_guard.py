"""The guard every HQ request passes before routing."""

import dataclasses

import pytest

from opencorp.hq.api import create_hq_app
from tests.hq.conftest import PORT, hq_client


@pytest.mark.parametrize("host", [f"127.0.0.1:{PORT + 1}", f"evil.example:{PORT}", f"[::1]:{PORT}", "127.0.0.1",
                                  f"127.0.0.1.:{PORT}", ""])
async def test_tcp_takes_only_127_0_0_1_and_the_bound_port(office, hq, host):
    async with hq_client(office, hq, host=host) as c:
        r = await c.get("/api/health")
    assert (r.status_code, r.json()["error"]) == (403, "host_not_allowed")


async def test_tcp_takes_127_0_0_1_on_the_bound_port(office, hq):
    async with hq_client(office, hq) as c:
        assert (await c.get("/api/health")).status_code == 200


async def test_hq_sock_takes_any_loopback_port_but_no_hostname(office, hq):
    async with hq_client(office, hq, port=None, host="127.0.0.1:5555") as c:
        assert (await c.get("/api/health")).status_code == 200
    async with hq_client(office, hq, port=None, host="rebind.example:5555") as c:
        assert (await c.get("/api/health")).status_code == 403


async def test_a_localhost_document_request_redirects_to_127_0_0_1_keeping_path_and_query(office, hq):
    async with hq_client(office, hq, host=f"localhost:{PORT}") as c:
        r = await c.get("/pair?x=1")
        assert r.status_code == 307 and r.headers["location"] == f"http://127.0.0.1:{PORT}/pair?x=1"
        r = await c.get("/people/a%2Fb", headers={"sec-fetch-dest": "document"})
        assert r.status_code == 307 and r.headers["location"] == f"http://127.0.0.1:{PORT}/people/a%2Fb"


@pytest.mark.parametrize(("method", "path", "dest", "host"), [
    ("GET", "/api/health", None, f"localhost:{PORT}"),
    ("GET", "/assets/a.js", "script", f"localhost:{PORT}"),
    ("POST", "/pair", None, f"localhost:{PORT}"),
    ("GET", "/pair", None, f"localhost:{PORT + 1}"),
])
async def test_any_other_localhost_request_is_403(office, hq, method, path, dest, host):
    async with hq_client(office, hq, host=host, **({"sec-fetch-dest": dest} if dest else {})) as c:
        r = await c.request(method, path)
    assert (r.status_code, r.json()["error"]) == (403, "host_not_allowed")


@pytest.mark.parametrize(("site", "status"), [("same-site", 403), ("cross-site", 403), ("same-origin", 200),
                                              ("none", 200)])
async def test_fetch_metadata_on_api(office, hq, site, status):
    async with hq_client(office, hq, **{"sec-fetch-site": site}) as c:
        r = await c.get("/api/health")
    assert r.status_code == status and (status == 200 or r.json()["error"] == "cross_site")


async def test_fetch_metadata_doesnt_gate_the_apps_pages(office, hq):
    async with hq_client(office, hq, **{"sec-fetch-site": "cross-site"}) as c:
        assert (await c.get("/")).status_code != 403


@pytest.mark.parametrize("origin", ["http://127.0.0.1:3000", "http://localhost:49380", "null",
                                    f"https://127.0.0.1:{PORT}"])
async def test_an_api_request_with_a_foreign_origin_is_403_even_a_read(office, hq, origin):
    async with hq_client(office, hq, origin=origin) as c:
        r = await c.get("/api/health")
    assert (r.status_code, r.json()["error"]) == (403, "origin_not_allowed")


async def test_a_read_with_no_origin_or_its_own_passes(office, hq):
    async with hq_client(office, hq) as c:
        assert (await c.get("/api/health")).status_code == 200
    async with hq_client(office, hq, origin=f"http://127.0.0.1:{PORT}") as c:
        assert (await c.get("/api/health")).status_code == 200


async def test_on_hq_sock_the_origin_must_match_the_forwarded_port(office, hq):
    async with hq_client(office, hq, port=None, host="127.0.0.1:5555", origin="http://127.0.0.1:5555") as c:
        assert (await c.get("/api/health")).status_code == 200
    async with hq_client(office, hq, port=None, host="127.0.0.1:5555", origin="http://127.0.0.1:5556") as c:
        assert (await c.get("/api/health")).status_code == 403


async def test_a_write_without_an_origin_is_403(office, hq):
    async with hq_client(office, hq) as c:
        r = await c.post("/api/pair", json={"code": "x"})
    assert (r.status_code, r.json()["error"]) == (403, "origin_not_allowed")


async def test_a_dev_origin_passes(office, hq):
    hq.config = dataclasses.replace(hq.config, dev_origins=("http://localhost:5173",))
    async with hq_client(office, hq, origin="http://localhost:5173") as c:
        assert (await c.post("/api/nope", json={})).status_code == 404  # past the guard, to the router


async def test_a_websocket_scope_is_closed_without_reaching_the_app(office, hq):
    reached, sent = [], []
    app = create_hq_app(office, hq, port=PORT)
    app.app = lambda *args: reached.append(args)

    async def receive():
        return {"type": "websocket.connect"}

    async def send(message):
        sent.append(message)

    scope = {"type": "websocket", "path": "/api/health", "headers": [(b"host", f"127.0.0.1:{PORT}".encode())]}
    await app(scope, receive, send)
    assert reached == [] and [m["type"] for m in sent] == ["websocket.close"]

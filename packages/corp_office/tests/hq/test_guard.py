"""The guard every HQ request passes before routing."""

import asyncio
import contextlib
import dataclasses
import json
import socket

import httpx
import pytest
import uvicorn
from starlette.responses import JSONResponse

from opencorp.hq import guard
from opencorp.hq.api import create_hq_app
from opencorp.hq.core import Hq
from opencorp.hq.guard import MAX_API_BODY, HqGuard
from tests.hq.conftest import ORIGIN, PORT, hq_client


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


async def echo(scope, receive, send):
    """An app that answers with the length of the body it received and whether it was whole."""
    message = await receive()
    body = {"length": len(message["body"]), "whole": not message["more_body"]}
    await JSONResponse(body)(scope, receive, send)


def echo_client(**headers) -> httpx.AsyncClient:
    """A client of the guard in front of ``echo``, sending the TCP listener's own host and origin."""
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=HqGuard(echo, port=PORT)), base_url=ORIGIN,
                             headers={"host": f"127.0.0.1:{PORT}", "origin": ORIGIN, **headers})


@pytest.mark.parametrize("kind", ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", None])
async def test_a_write_that_isnt_json_is_415(web, kind):
    r = await web.post("/api/pair", content=b'{"code":"x"}', headers={"content-type": kind} if kind else {})
    assert (r.status_code, r.json()["error"]) == (415, "json_required")


async def test_a_body_less_write_with_the_json_type_passes(web):
    r = await web.post("/api/nope", headers={"content-type": "application/json; charset=utf-8"})
    assert r.status_code == 404  # past the guard, to the router


async def test_the_guard_refuses_in_order_host_then_fetch_metadata_then_origin_then_json(office, hq):
    text = {"content": b"x", "headers": {"content-type": "text/plain"}}
    async with hq_client(office, hq, host="evil.example:49380", origin="http://evil.example:49380") as c:
        assert (await c.post("/api/pair", **text)).json()["error"] == "host_not_allowed"
    async with hq_client(office, hq, origin=ORIGIN, **{"sec-fetch-site": "cross-site"}) as c:
        assert (await c.post("/api/pair", **text)).json()["error"] == "cross_site"
    async with hq_client(office, hq, origin="http://127.0.0.1:3000") as c:
        assert (await c.post("/api/pair", **text)).json()["error"] == "origin_not_allowed"


async def test_a_write_up_to_16_kib_reaches_the_app_whole():
    body = b"x" * MAX_API_BODY

    async def chunks():
        yield body[:9000]
        yield body[9000:]

    async with echo_client(**{"content-type": "application/json"}) as c:
        assert (await c.post("/api/pair", content=body)).json() == {"length": MAX_API_BODY, "whole": True}
        assert (await c.post("/api/pair", content=chunks())).json() == {"length": MAX_API_BODY, "whole": True}


async def test_a_write_over_16_kib_is_413_with_or_without_a_length(web):
    big = json.dumps({"code": "x" * 17000}).encode()
    r = await web.post("/api/pair", content=big, headers={"content-type": "application/json"})
    assert (r.status_code, r.json()["error"]) == (413, "too_large")

    async def chunks():
        yield big[:9000]
        yield big[9000:]

    r = await web.post("/api/pair", content=chunks(), headers={"content-type": "application/json"})
    assert (r.status_code, r.json()["error"]) == (413, "too_large")


async def test_a_declared_length_over_16_kib_is_413_before_the_body_is_read():
    async def receive():
        raise AssertionError("the body was read")

    sent = []

    async def send(message):
        sent.append(message)

    scope = {"type": "http", "method": "POST", "path": "/api/pair", "query_string": b"",
             "headers": [(b"host", f"127.0.0.1:{PORT}".encode()), (b"origin", ORIGIN.encode()),
                         (b"content-type", b"application/json"), (b"content-length", b"17000")]}
    await HqGuard(echo, port=PORT)(scope, receive, send)
    assert sent[0]["status"] == 413


async def test_a_client_that_goes_away_mid_body_never_reaches_the_app():
    messages = iter([{"type": "http.request", "body": b'{"code":', "more_body": True}, {"type": "http.disconnect"}])
    reached, sent = [], []

    async def app(scope, receive, send):
        reached.append(scope)

    async def receive():
        return next(messages)

    async def send(message):
        sent.append(message)

    scope = {"type": "http", "method": "POST", "path": "/api/pair", "query_string": b"",
             "headers": [(b"host", f"127.0.0.1:{PORT}".encode()), (b"origin", ORIGIN.encode()),
                         (b"content-type", b"application/json")]}
    await HqGuard(app, port=PORT)(scope, receive, send)
    assert reached == [] and sent == []


@pytest.mark.parametrize("path", ["/api/health", "/api/nope", "/missing.js", "/"])
async def test_every_response_carries_the_security_headers(web, path):
    r = await web.get(path)
    assert r.headers["content-security-policy"].startswith("default-src 'none'; script-src 'self'")
    assert (r.headers["x-frame-options"], r.headers["x-content-type-options"], r.headers["referrer-policy"],
            r.headers["cross-origin-opener-policy"]) == ("DENY", "nosniff", "no-referrer", "same-origin")


async def test_a_refusal_and_a_redirect_carry_them_too(office, hq):
    async with hq_client(office, hq, host="evil.example:49380") as c:
        assert "content-security-policy" in (await c.get("/")).headers
    async with hq_client(office, hq, host=f"localhost:{PORT}") as c:
        r = await c.get("/")
    assert r.status_code == 307 and r.headers["x-frame-options"] == "DENY"


async def test_a_500_carries_them_too(office, hq, monkeypatch):
    monkeypatch.setattr(Hq, "health", lambda self: 1 / 0)
    # Starlette re-raises after answering 500; the transport mustn't turn that into a test error.
    transport = httpx.ASGITransport(app=create_hq_app(office, hq, port=PORT), raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url=ORIGIN, headers={"host": f"127.0.0.1:{PORT}"}) as c:
        r = await c.get("/api/health")
    assert r.status_code == 500 and r.headers["x-frame-options"] == "DENY"


async def test_a_body_that_stops_arriving_is_408(web, monkeypatch):
    monkeypatch.setattr(guard, "BODY_TIMEOUT_S", 0.2)

    async def stalls():
        yield b'{"code":'
        await asyncio.sleep(5)  # a slow client holding one of HQ's connections
        yield b'"x"}'

    async with asyncio.timeout(3):
        r = await web.post("/api/pair", content=stalls(), headers={"content-type": "application/json"})
    assert (r.status_code, r.json()["error"]) == (408, "body_timeout")


@contextlib.asynccontextmanager
async def served(app_for_port):
    """Serve ``app_for_port(port)`` with uvicorn's h11 protocol on a free loopback port; yields the port."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app_for_port(port), lifespan="off", ws="none", http="h11",
                                           log_level="warning", timeout_keep_alive=5))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        async with asyncio.timeout(10):
            while not server.started:
                await asyncio.sleep(0.01)
        yield port
    finally:
        server.should_exit = True
        await task
        sock.close()


async def trickle(port: int, head: str, seconds: float = 4.0) -> tuple[bytes, bool]:
    """Send ``head``, then a byte of body every 0.1 s; the response and whether the server closed within
    ``seconds``."""
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(head.encode())
    got = b""
    try:
        async with asyncio.timeout(seconds):
            while True:
                writer.write(b"x")
                await writer.drain()
                try:
                    data = await asyncio.wait_for(reader.read(4096), 0.1)
                except TimeoutError:
                    continue
                if not data:
                    return got, True
                got += data
    except TimeoutError:
        return got, False
    except ConnectionError:
        return got, True
    finally:
        writer.close()


def post(port: int, path: str, *extra: str) -> str:
    """A POST head from the app's own page that promises a 1000-byte JSON body."""
    return "".join([f"POST {path} HTTP/1.1\r\n", f"Host: 127.0.0.1:{port}\r\n", f"Origin: http://127.0.0.1:{port}\r\n",
                    "Content-Type: application/json\r\n", *extra, "Content-Length: 1000\r\n\r\n"])


async def test_a_408_closes_the_connection_while_the_client_still_trickles(monkeypatch):
    monkeypatch.setattr(guard, "BODY_TIMEOUT_S", 0.5)
    async with served(lambda port: HqGuard(echo, port=port)) as port:
        got, closed = await trickle(port, post(port, "/api/pair"))
    assert got.startswith(b"HTTP/1.1 408") and b"connection: close" in got and closed


async def test_a_413_closes_the_connection_before_the_body_is_read():
    async with served(lambda port: HqGuard(echo, port=port)) as port:
        got, closed = await trickle(port, post(port, "/api/pair").replace("1000", "20000"))
    assert got.startswith(b"HTTP/1.1 413") and closed


async def test_a_response_that_leaves_the_body_unread_closes_the_connection():
    async def ignores_the_body(scope, receive, send):
        await JSONResponse({}, 405)(scope, receive, send)

    async with served(lambda port: HqGuard(ignores_the_body, port=port)) as port:
        got, closed = await trickle(port, post(port, "/some/page"))
    assert got.startswith(b"HTTP/1.1 405") and b"connection: close" in got and closed


async def test_a_refusal_closes_the_connection():
    async with served(lambda port: HqGuard(echo, port=port)) as port:
        got, closed = await trickle(port, post(port, "/api/pair").replace(f"127.0.0.1:{port}\r\nOrigin",
                                                                         f"evil.example:{port}\r\nOrigin"))
    assert got.startswith(b"HTTP/1.1 403") and closed


async def test_a_read_body_keeps_the_connection_open():
    async with served(lambda port: HqGuard(echo, port=port)) as port, \
            httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", trust_env=False,
                              headers={"origin": f"http://127.0.0.1:{port}"}) as c:
        r = await c.post("/api/pair", json={"code": "x"})
    assert r.status_code == 200 and "connection" not in r.headers

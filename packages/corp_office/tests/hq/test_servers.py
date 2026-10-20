"""HQ's servers: limits per listener, isolation from office.sock, bind and rebind."""

import asyncio

from opencorp.hq.servers import HqH11Protocol
from tests.daemon.conftest import served
from tests.hq.conftest import hq_served

REQUEST = b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:5555\r\n\r\n"


async def test_the_65th_connection_is_closed_and_office_sock_still_answers(office, hq, short_dir):
    # served() starts the office a second time (hq already did); harmless for these checks.
    async with hq_served(office, hq, short_dir / "hq.sock"), served(office, short_dir / "o.sock") as sock_client:
        # MAX_OPEN more, whatever hq_served's own keep-alive connection does; the next one is over the cap either way.
        held = [await asyncio.open_unix_connection(str(short_dir / "hq.sock")) for _ in range(HqH11Protocol.MAX_OPEN)]
        reader, writer = await asyncio.open_unix_connection(str(short_dir / "hq.sock"))
        assert await asyncio.wait_for(reader.read(), 2) == b""
        assert (await sock_client.get("/health")).status_code == 200
        for _, w in held:
            w.close()


async def test_a_connection_without_a_full_request_head_is_closed(office, hq, short_dir, monkeypatch):
    monkeypatch.setattr(HqH11Protocol, "HEAD_TIMEOUT_S", 0.3)
    async with hq_served(office, hq, short_dir / "hq.sock"):
        reader, writer = await asyncio.open_unix_connection(str(short_dir / "hq.sock"))
        writer.write(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:55")
        assert await asyncio.wait_for(reader.read(), 2) == b""
        reader, writer = await asyncio.open_unix_connection(str(short_dir / "hq.sock"))
        writer.write(REQUEST)
        assert (await asyncio.wait_for(reader.readline(), 2)).startswith(b"HTTP/1.1 200")
        writer.close()


async def test_the_next_request_head_on_a_kept_alive_connection_has_its_own_deadline(office, hq, short_dir,
                                                                                      monkeypatch):
    monkeypatch.setattr(HqH11Protocol, "HEAD_TIMEOUT_S", 0.3)
    async with hq_served(office, hq, short_dir / "hq.sock"):
        reader, writer = await asyncio.open_unix_connection(str(short_dir / "hq.sock"))
        writer.write(REQUEST)
        assert (await asyncio.wait_for(reader.readline(), 2)).startswith(b"HTTP/1.1 200")
        # A byte of the next head stops uvicorn's keep-alive timer; the head deadline still closes the connection.
        writer.write(b"G")
        assert await asyncio.wait_for(reader.read(), 2) != b""  # the rest of the first response, then EOF
        assert reader.at_eof()


async def test_a_websocket_upgrade_is_served_as_plain_http_on_hq(office, hq, short_dir):
    async with hq_served(office, hq, short_dir / "hq.sock"):
        reader, writer = await asyncio.open_unix_connection(str(short_dir / "hq.sock"))
        writer.write(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:5555\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"
                     b"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n")
        # ws="none": the upgrade is ignored and /api/health answers; with WebSockets on it would be a 403.
        assert (await asyncio.wait_for(reader.readline(), 2)).startswith(b"HTTP/1.1 200")
        writer.close()


async def test_idle_connections_never_503_the_owner(office, hq, short_dir):
    async with hq_served(office, hq, short_dir / "hq.sock") as c:
        assert (await c.get("/api/health")).status_code == 200  # c keeps this connection open (keep-alive)
        idle = [await asyncio.open_unix_connection(str(short_dir / "hq.sock"))
                for _ in range(HqH11Protocol.MAX_OPEN - 2)]
        reader, writer = await asyncio.open_unix_connection(str(short_dir / "hq.sock"))  # the 64th open connection
        writer.write(REQUEST)
        # uvicorn's limit_concurrency=64 would count the idle ones and answer "503 Exceeded concurrency limit".
        assert (await asyncio.wait_for(reader.readline(), 2)).startswith(b"HTTP/1.1 200")
        writer.close()
        for _, w in idle:
            w.close()


async def test_hq_never_serves_socket_routes_and_the_socket_never_serves_hq(office, hq, short_dir):
    async with hq_served(office, hq, short_dir / "hq.sock") as web, served(office, short_dir / "o.sock") as sock_client:
        r = await web.get("/hq", headers={"sec-fetch-dest": "document"})
        assert "application/json" not in r.headers["content-type"]  # the app's page, not HqStatus
        r = await sock_client.get("/api/health")
        assert (r.status_code, r.json()["error"]) == (404, "no_route")

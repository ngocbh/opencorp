"""HQ's servers: limits per listener, isolation from office.sock, bind and rebind."""

import asyncio
import dataclasses
import os
import socket
import stat

import httpx
import pytest

from opencorp.daemon.sockets import bind_socket
from opencorp.hq import servers
from opencorp.hq.servers import HqH11Protocol, Listeners
from opencorp.protocol.models import HqTcp
from tests.daemon.conftest import served
from tests.hq.conftest import hq_served
from tests.hq.net import free_port

REQUEST = b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:5555\r\n\r\n"


@pytest.fixture
def hq_settings(tmp_path):  # overrides tests/hq/conftest.py: TCP on, on a free port
    return {"tcp": True, "port": free_port(), "app_dir": str(tmp_path / "dist")}


@pytest.fixture
def short_office(office, short_dir, monkeypatch):
    """The office's dir on a short path, so hq.sock fits in sun_path."""
    monkeypatch.setattr(office.paths, "office", short_dir)
    return office


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


async def test_hq_sock_is_0600_and_tcp_listens_on_the_port(short_office, hq):
    listeners = Listeners(hq)
    await listeners.start()
    try:
        async with asyncio.timeout(3):
            while hq.bound_port is None:
                await asyncio.sleep(0.02)
        assert stat.S_IMODE(os.stat(hq.socket).st_mode) == 0o600
        assert hq.status().url == f"http://127.0.0.1:{hq.config.port}/"
        async with httpx.AsyncClient(base_url=hq.status().url, trust_env=False) as c:
            assert (await c.get("/api/health")).json()["ok"] is True
        async with httpx.AsyncClient(transport=httpx.AsyncHTTPTransport(uds=str(hq.socket)),
                                     base_url="http://127.0.0.1:5555") as c:
            assert (await c.get("/api/health")).json()["ok"] is True
    finally:
        await listeners.stop()
    assert not hq.socket.exists() and hq.bound_port is None


async def test_a_stale_hq_sock_is_replaced(short_office, hq):
    hq.config = dataclasses.replace(hq.config, tcp=False)
    bind_socket(hq.socket).close()  # closing leaves the file, as a crash does
    listeners = Listeners(hq)
    await listeners.start()
    try:
        assert hq.socket_error is None
        async with httpx.AsyncClient(transport=httpx.AsyncHTTPTransport(uds=str(hq.socket)),
                                     base_url="http://127.0.0.1:5555") as c:
            assert (await c.get("/api/health")).status_code == 200
    finally:
        await listeners.stop()


async def test_a_taken_port_is_retried_and_picked_up_once_free(short_office, hq, monkeypatch, caplog):
    monkeypatch.setattr(servers, "RETRY_S", 0.2)
    holder = socket.socket()
    holder.bind(("127.0.0.1", hq.config.port))
    holder.listen()
    listeners = Listeners(hq)
    await listeners.start()
    try:
        await asyncio.sleep(0.5)
        status = hq.status()
        assert not status.tcp.listening and status.tcp.error and status.tcp.next_retry_at
        assert caplog.text.count("can't listen on 127.0.0.1") == 1  # only state changes are logged
        holder.close()
        async with asyncio.timeout(2):
            while hq.bound_port is None:
                await asyncio.sleep(0.05)
        assert hq.status().tcp.error is None and hq.status().tcp.next_retry_at is None
    finally:
        holder.close()
        await listeners.stop()


async def test_stop_ends_the_retries(short_office, hq, monkeypatch):
    monkeypatch.setattr(servers, "RETRY_S", 0.1)
    holder = socket.socket()
    holder.bind(("127.0.0.1", hq.config.port))
    holder.listen()
    listeners = Listeners(hq)
    await listeners.start()
    await asyncio.sleep(0.2)
    await listeners.stop()
    holder.close()
    await asyncio.sleep(0.3)
    assert hq.bound_port is None
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", hq.config.port))  # nobody took the port after stop


async def test_with_tcp_off_only_hq_sock_listens(short_office, hq):
    hq.config = dataclasses.replace(hq.config, tcp=False)
    listeners = Listeners(hq)
    await listeners.start()
    try:
        assert hq.socket.exists() and hq.status().tcp == HqTcp(enabled=False, port=hq.config.port, listening=False)
    finally:
        await listeners.stop()


async def test_a_failed_hq_sock_bind_is_a_warning(office, hq, short_dir, monkeypatch):
    deep = short_dir / ("d" * 110)  # hq.sock's path is now past sun_path's 104 bytes
    deep.mkdir()
    monkeypatch.setattr(office.paths, "office", deep)
    hq.config = dataclasses.replace(hq.config, tcp=False)
    listeners = Listeners(hq)
    await listeners.start()  # the office runs on
    try:
        assert any("isn't listening on" in w and "hq.sock" in w for w in hq.status().warnings)
    finally:
        await listeners.stop()


async def test_an_os_error_at_hq_sock_is_a_warning_too(short_office, hq, monkeypatch):
    def refused(path):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(servers, "remove_stale_socket", refused)
    hq.config = dataclasses.replace(hq.config, tcp=False)
    listeners = Listeners(hq)
    await listeners.start()  # the office runs on
    try:
        assert any("isn't listening on" in w and "Permission denied" in w for w in hq.status().warnings)
    finally:
        await listeners.stop()


@pytest.mark.parametrize("kind", ["file", "dir"])
async def test_stop_leaves_alone_what_start_refused_at_hq_sock(short_office, hq, kind):
    hq.config = dataclasses.replace(hq.config, tcp=False)
    if kind == "file":
        hq.socket.write_text("not ours")
    else:
        hq.socket.mkdir()
    listeners = Listeners(hq)
    await listeners.start()
    assert hq.socket_error is not None
    await listeners.stop()
    assert hq.socket.exists() and hq.socket_error is None


def _failing_once(monkeypatch, exc):
    """Make the next HqServer.serve raise ``exc`` at once; later ones serve as usual."""
    real, calls = servers.HqServer.serve, []

    async def serve(self, sockets=None):
        calls.append(sockets)
        if len(calls) == 1:
            raise exc
        await real(self, sockets=sockets)

    monkeypatch.setattr(servers.HqServer, "serve", serve)
    return calls


async def test_a_tcp_server_that_dies_is_noticed_and_the_port_bound_again(short_office, hq, monkeypatch, caplog):
    monkeypatch.setattr(servers, "RETRY_S", 0.1)
    calls = _failing_once(monkeypatch, RuntimeError("crashed"))
    hq.config = dataclasses.replace(hq.config, tcp=True)
    monkeypatch.setattr(short_office.paths, "office", short_office.paths.office / "nope")  # no hq.sock: TCP only
    listeners = Listeners(hq)
    await listeners.start()
    try:
        async with asyncio.timeout(3):
            while len(calls) < 2 or hq.bound_port is None:
                await asyncio.sleep(0.02)
        assert "crashed" in caplog.text and hq.tcp_error is None
        async with httpx.AsyncClient(base_url=hq.status().url, trust_env=False) as c:
            assert (await c.get("/api/health")).status_code == 200
    finally:
        await listeners.stop()


async def test_a_hq_sock_server_that_exits_is_a_warning_not_a_stopped_office(short_office, hq, monkeypatch):
    _failing_once(monkeypatch, SystemExit(1))
    hq.config = dataclasses.replace(hq.config, tcp=False)
    listeners = Listeners(hq)
    await listeners.start()
    try:
        async with asyncio.timeout(2):
            while hq.socket_error is None:
                await asyncio.sleep(0.02)
        assert any("isn't listening on" in w for w in hq.status().warnings)
    finally:
        await listeners.stop()
    assert not hq.socket.exists()


async def test_stop_logs_what_went_wrong_instead_of_raising(short_office, hq, monkeypatch, caplog):
    def broken(port):
        raise ValueError("no such port")

    monkeypatch.setattr(servers, "bind_tcp", broken)

    async def late(self, sockets=None):
        while not self.should_exit:
            await asyncio.sleep(0.01)
        raise RuntimeError("failed on the way out")

    monkeypatch.setattr(servers.HqServer, "serve", late)
    listeners = Listeners(hq)
    await listeners.start()
    await asyncio.sleep(0.05)
    await listeners.stop()
    assert "no such port" in caplog.text and "failed on the way out" in caplog.text

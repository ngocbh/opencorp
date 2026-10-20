"""HQ fixtures: an office with HQ attached but not listening, and clients for its HQ app."""

import asyncio
import contextlib
import json

import httpx
import pytest

from opencorp.daemon.main import bind_socket
from opencorp.hq.api import create_hq_app
from opencorp.hq.core import attach
from opencorp.hq.servers import HqServer, hq_config
from tests.company.conftest import make_company  # noqa: F401
from tests.daemon.conftest import _isolate_git, company, office, profile_stores, short_dir  # noqa: F401

PORT = 49380
ORIGIN = f"http://127.0.0.1:{PORT}"


@pytest.fixture
def hq_settings(tmp_path):
    """What the test's ``office/hq.json`` holds; a module overrides this fixture to change it."""
    return {"tcp": False, "app_dir": str(tmp_path / "dist")}


@pytest.fixture
def dist(tmp_path):
    """A built app: index.html, one hashed asset, theme.js and build.json."""
    root = tmp_path / "dist"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text("<!doctype html><title>OpenCorp HQ</title>")
    (root / "assets" / "index-abc123.js").write_text("console.log(1)")
    (root / "theme.js").write_text("// theme")
    (root / "build.json").write_text(json.dumps({"build": "b1", "api": "x"}))
    return root


@pytest.fixture
async def hq(office, hq_settings):
    """HQ attached to a started office, with ``hq_settings`` as its ``hq.json``."""
    office.paths.office.mkdir(parents=True, exist_ok=True)
    (office.paths.office / "hq.json").write_text(json.dumps(hq_settings))
    found = attach(office, listen=False)
    await office.start()
    yield found
    await office.stop()


def hq_client(office, hq, *, port: int | None = PORT, host: str = f"127.0.0.1:{PORT}", **headers) -> httpx.AsyncClient:
    """A client of the HQ app for the TCP listener on ``port`` (None: ``hq.sock``), sending ``host``."""
    app = create_hq_app(office, hq, port=port)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=f"http://{host}",
                             headers={"host": host, **headers})


@pytest.fixture
async def web(office, hq):
    """A client of the TCP listener's HQ app that sends the app's own origin, as the app's pages do."""
    async with hq_client(office, hq, origin=ORIGIN) as c:
        yield c


@pytest.fixture
async def signed_in(web, hq):
    """``web`` with a browser session for the CEO."""
    code = (await hq.mint("ngocbh", issuer="ngocbh", open_file=False)).path.split("#")[1]
    assert (await web.post("/api/pair", json={"code": code})).status_code == 200
    return web


@contextlib.asynccontextmanager
async def hq_served(office, hq, socket_path, *, host="127.0.0.1:5555"):
    """Serve the hq.sock flavour of the HQ app on ``socket_path`` in this loop; yields a signed-in client over it.

    Streams need a real server: httpx's ASGITransport buffers whole responses.
    """
    sock = bind_socket(socket_path)
    server = HqServer(hq_config(create_hq_app(office, hq, port=None)))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    async with asyncio.timeout(10):
        while not server.started:
            if task.done():
                sock.close()
                await task  # re-raises what stopped it
                raise RuntimeError("uvicorn stopped before it started")
            await asyncio.sleep(0.01)
    transport = httpx.AsyncHTTPTransport(uds=str(socket_path))
    async with httpx.AsyncClient(transport=transport, base_url=f"http://{host}", timeout=10,
                                 headers={"origin": f"http://{host}"}) as c:
        try:
            code = (await hq.mint("ngocbh", issuer="ngocbh", open_file=False)).path.split("#")[1]
            assert (await c.post("/api/pair", json={"code": code})).status_code == 200
            yield c
        finally:
            office.bus.close()  # ends open streams, as the office's own shutdown does
            server.should_exit = True
            await task
            socket_path.unlink(missing_ok=True)


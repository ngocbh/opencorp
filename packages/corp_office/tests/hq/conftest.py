"""HQ fixtures: an office with HQ attached but not listening, and clients for its HQ app."""

import json

import httpx
import pytest

from opencorp.hq.api import create_hq_app
from opencorp.hq.core import attach
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

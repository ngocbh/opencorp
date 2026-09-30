"""Office fixtures: a company repo, a store, an ASGI client, and test doubles."""

import asyncio
import contextlib
import hashlib
import shutil
import tempfile
from pathlib import Path

import httpx
import pytest
import uvicorn
from agent_composer.memory.storage.markdown import MarkdownVersionMismatch

from agent_corp.company.git import CompanyGit
from agent_corp.daemon.app import Office, OfficePaths, create_app
from agent_corp.daemon.bus import Bus
from agent_corp.daemon.main import OfficeServer, bind_socket
from agent_corp.store import Store
from tests.company.conftest import _isolate_git, base_files, company, write_repo  # noqa: F401

EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"


def blob_id(data: bytes) -> str:
    """The git blob id of ``data``."""
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


class BlobFileStore:
    """A MarkdownStore over one file, versioned by git blob id; only the current version is readable."""

    def __init__(self, path):
        self.path = path
        self.provenance: list[dict | None] = []

    def _current(self) -> tuple[str, str]:
        data = self.path.read_bytes() if self.path.exists() else b""
        return data.decode(), blob_id(data)

    def read(self, version=None):
        text, current = self._current()
        if version is not None and version != current:
            raise LookupError(version)
        return text, current

    def write(self, text, *, base_version, provenance=None):
        _, current = self._current()
        if base_version != current:
            raise MarkdownVersionMismatch(base_version, current)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_bytes(text.encode())
        self.provenance.append(provenance)
        return blob_id(text.encode())


class FakePool:
    """A WorkerPool that counts close_all calls."""

    def __init__(self):
        self.closed = 0

    def close_all(self):
        self.closed += 1


@pytest.fixture
def profile_stores():
    return {}


@pytest.fixture
def office(company, tmp_path, profile_stores):
    paths = OfficePaths(tmp_path)  # paths.company == the company fixture's repo
    store = Store(paths.store)

    def profile_store(pid):
        return profile_stores.setdefault(pid, BlobFileStore(company / "people" / pid / "profile.md"))

    yield Office(paths=paths, store=store, git=CompanyGit(company, paths.worktrees), bus=Bus(),
                 profile_store=profile_store)
    store.close()


@pytest.fixture
async def client(office):
    await office.start()
    transport = httpx.ASGITransport(app=create_app(office))
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
        yield c
    await office.stop()


@pytest.fixture
def short_dir():
    """A directory with a short path: macOS unix socket paths are limited to 104 bytes."""
    path = Path(tempfile.mkdtemp(prefix="ac-", dir="/tmp")).resolve()  # /tmp is /private/tmp on macOS
    yield path
    shutil.rmtree(path, ignore_errors=True)


@contextlib.asynccontextmanager
async def served(office, socket_path: Path):
    """Serve ``office`` on ``socket_path`` in this loop; yields an httpx client over the socket."""
    sock = bind_socket(socket_path)
    server = OfficeServer(uvicorn.Config(create_app(office), lifespan="on", log_level="warning",
                                         timeout_graceful_shutdown=2), office)
    task = asyncio.create_task(server.serve(sockets=[sock]))
    while not server.started:
        await asyncio.sleep(0.01)
    transport = httpx.AsyncHTTPTransport(uds=str(socket_path))
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost", timeout=10) as c:
        try:
            yield c
        finally:
            server.handle_exit(0, None)
            await task
            socket_path.unlink(missing_ok=True)

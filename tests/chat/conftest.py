"""Harness fixtures: a git company using the shipped chat flow, a store, a FakeLLM provider, and a harness."""

import time
from importlib.resources import files
from types import SimpleNamespace

import pytest

from agent_corp.assets.registry import builtin_kinds
from agent_corp.chat.harness import Harness
from agent_corp.chat.provider import Provider
from agent_corp.company.git import CompanyGit
from agent_corp.daemon.app import OfficePaths
from agent_corp.perm.monitor import Monitor
from agent_corp.secrets import SecretStore
from agent_corp.store import Store
from agent_corp.testing.fake_llm import LLM_CONFIG, FakeLLM
from tests.company.conftest import _isolate_git, base_files, write_repo  # noqa: F401

CHAT_FLOW = (files("agent_corp.company_template") / "shared" / "flows" / "chat.yaml").read_text()


class LiveLog:
    """A bus that records live events."""

    def __init__(self):
        self.events = []

    def publish_live(self, event):
        self.events.append(event)


def wait_for(predicate, timeout: float = 30, what: str = "condition"):
    """Poll ``predicate`` until it returns something truthy; return that."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    raise AssertionError(f"timed out waiting for {what}")


@pytest.fixture
def fake_llm():
    with FakeLLM() as fake:
        yield fake


@pytest.fixture
def workspace(tmp_path):
    path = tmp_path / "ws"
    path.mkdir()
    return path


@pytest.fixture
def make_harness(tmp_path, fake_llm):
    """Build a harness over a fresh company; ``defaults`` and ``files`` override the base company."""
    made = []

    def make(*, defaults=None, files=None, kinds=None, prices=None, company=None, llm_config=None):
        paths = OfficePaths(tmp_path)
        if company is None and not paths.company.exists():
            repo_files = base_files() | {"shared/flows/chat.yaml": CHAT_FLOW}
            repo_files["company.yaml"] = dict(repo_files["company.yaml"])
            repo_files["company.yaml"]["defaults"] = {**repo_files["company.yaml"]["defaults"], **(defaults or {})}
            write_repo(paths.company, repo_files | (files or {}))
        paths.office.mkdir(parents=True, exist_ok=True)
        store = Store(paths.store)
        git = CompanyGit(paths.company, paths.worktrees)
        office = SimpleNamespace(paths=paths, store=store, git=git, bus=LiveLog())
        monitor = Monitor(paths.company, store, SecretStore(paths.secrets), kinds or builtin_kinds())
        provider = Provider(llm_config=llm_config or LLM_CONFIG, env=fake_llm.env(), prices=prices or {})
        harness = Harness(office, monitor, provider=lambda: provider)
        made.append(harness)
        return harness

    yield make
    for harness in made:
        if not harness._stopping:
            harness.close_all()
        elif not harness._closed:
            # The test played a dead office. Its worker's reader thread and its dispatcher
            # may still be handling the worker's exit, so let them finish before the store closes.
            harness.registry.close_all()
            harness._jobs.put(None)
            harness._thread.join(10)
        harness.store.close()


@pytest.fixture
def harness(make_harness):
    return make_harness()


def status(harness, sid):
    return harness.store.get_session(sid).status


def texts(harness, sid, role="assistant"):
    """The text parts of a session's messages with ``role``, in order."""
    return [p.text for m in harness.store.list_messages(sid) if m.role == role
            for p in m.parts if p.type == "text"]

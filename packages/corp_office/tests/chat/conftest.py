"""Harness fixtures: a git company using the shipped chat flow, a store, a FakeLLM provider, and a harness."""

import time
from importlib.resources import files
from types import SimpleNamespace

import pytest

from agent_corp.assets.registry import builtin_kinds
from agent_corp.chat.connections import ConnectionFile, Connections
from agent_corp.chat.harness import Harness
from agent_corp.chat.models import Listing, ModelCache, own_models
from agent_corp.chat.provider import Provider
from agent_corp.company.git import CompanyGit
from agent_corp.daemon.app import OfficePaths
from agent_corp.perm.monitor import Monitor
from agent_corp.protocol.models import ModelOption
from agent_corp.secrets import SecretStore, write_private
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


def lister(listings):
    """A lister that gives each connection in ``listings`` (``{name: [model id]}``) as listed, and any other
    connection only its configured model; it never reaches the network."""
    def list_models(conn, name, *, deadline):
        if name in listings:
            return Listing(connection=name, models=[ModelOption(id=i) for i in listings[name]], listed=True)
        return own_models(conn, name)

    return list_models


@pytest.fixture
def make_harness(tmp_path, fake_llm):
    """Build a harness over a fresh company; ``defaults`` and ``files`` override the base company.

    office/provider.json is written from ``llm_config`` and ``prices`` on the FakeLLM; ``connections``
    (``{name: model}``) adds connections on the FakeLLM. The harness's model cache lists connections with
    ``models`` (a lister), else with ``lister(listings or {})``; ``choose_deadline`` replaces its 8 s.
    """
    made = []

    def make(*, defaults=None, files=None, kinds=None, prices=None, company=None, llm_config=None, connections=None,
             listings=None, models=None, choose_deadline=None):
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
        write_private(paths.office / "provider.json", provider.model_dump_json().encode())
        conns = Connections(paths.office)
        for name, model in (connections or {}).items():
            conns.put(name, ConnectionFile(llm_config={**LLM_CONFIG, "model": model}, env=fake_llm.env()))
        cache = ModelCache(conns, lister=models or lister(listings or {}))
        extra = {} if choose_deadline is None else {"choose_deadline": choose_deadline}
        harness = Harness(office, monitor, connections=conns, models=cache, **extra)
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


def errors(harness, sid):
    """The error parts' messages of a session, in order."""
    return [p.message for m in harness.store.list_messages(sid) for p in m.parts if p.type == "error"]


def texts(harness, sid, role="assistant"):
    """The text parts of a session's messages with ``role``, in order."""
    return [p.text for m in harness.store.list_messages(sid) if m.role == role
            for p in m.parts if p.type == "text"]


def say(harness, sid, text):
    """Send ``text`` and wait for its reply and the next turn; return the reply."""
    n = len(texts(harness, sid))
    harness.prompt(sid, text)
    wait_for(lambda: len(texts(harness, sid)) > n and status(harness, sid) == "idle", what=f"the reply to {text!r}")
    return texts(harness, sid)[-1]


def on(harness, sid, name, model=None):
    """Put a session on connection ``name`` (None: ``office``) and ``model``, as a switch would."""
    return harness.store.update_session(sid, connection=name, model=model)


def spawned(harness, see=lambda job: job):
    """What ``see`` makes of each Job the harness's registry spawns, in order; ``see`` runs before the spawn."""
    seen = []
    spawn = harness.registry.spawn

    def spy(job, *args):
        seen.append(see(job))
        return spawn(job, *args)

    harness.registry.spawn = spy
    return seen

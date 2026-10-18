"""Codex fixtures: a harness whose minh may use Codex, and a fake app-server scripted per test."""

import json
import sys
from pathlib import Path

import pytest
from jsonschema import Draft7Validator

from agent_corp.harness.sessions import CodexSessions
from tests.chat.conftest import (_isolate_git, errors, fake_llm, make_harness, status, texts, wait_for,  # noqa: F401
                                 workspace)
from tests.company.conftest import person

CODEX_PERSON = {"people/minh/person.yaml": person("minh", harnesses=["composer", "codex"])}
CLIENT = Draft7Validator(json.loads(
    (Path(__file__).parent / "fixtures" / "codex" / "schema" / "ClientRequest.json").read_text()))


class FakeCodex:
    """The fake app-server's script and log for one test; the script is read when an app-server starts."""

    def __init__(self, root):
        root.mkdir()
        self.path, self.log = root / "script.json", root / "rpc.jsonl"
        self.script()

    def script(self, turns=(), **extra):
        self.path.write_text(json.dumps({"thread": {"id": "thr_1", "model": "gpt-5.5-codex"},
                                         "turns": list(turns), **extra}))

    def command(self):
        return [sys.executable, "-I", "-m", "agent_corp.testing.fake_codex", "--script", str(self.path),
                "--log", str(self.log)]

    def entries(self, direction):
        lines = self.log.read_text().splitlines() if self.log.exists() else []
        return [e for e in map(json.loads, lines) if e["dir"] == direction]

    def messages(self, direction="in"):
        return [e["msg"] for e in self.entries(direction)]

    def calls(self, method):
        """The params of each request the office sent with ``method``."""
        return [m.get("params") for m in self.messages() if m.get("method") == method]

    def replies(self):
        """The office's replies to the fake's requests: ``{request id: result or error}``."""
        return {m["id"]: m.get("result", m.get("error")) for m in self.messages() if "method" not in m}

    def spawned(self):
        """The pids of the children the fake started (``{"spawn": seconds}`` steps)."""
        return [e["pid"] for e in self.entries("spawn")]


def requests_valid(fake_codex):
    """Check every request the office sent against the pinned ``ClientRequest.json``."""
    for m in fake_codex.messages():
        if "method" in m and "id" in m:
            CLIENT.validate(m)


@pytest.fixture
def fake_codex(tmp_path):
    return FakeCodex(tmp_path / "fake-codex")


@pytest.fixture
def make_codex(make_harness, fake_codex):
    def make(**over):
        files = CODEX_PERSON | over.pop("files", {})
        return make_harness(files=files, codex=lambda office, hooks: CodexSessions(
            office, hooks, command=fake_codex.command, close_grace=0.5), **over)
    return make


@pytest.fixture
def harness(make_codex):
    return make_codex()


def stored(harness, sid):
    """Everything the store keeps of a session, as text: its row, its messages, and every event."""
    return "\n".join([harness.store.get_session(sid).model_dump_json(),
                      *(m.model_dump_json() for m in harness.store.list_messages(sid)),
                      *(str(e.data) for e in harness.store.events_after())])


def codex_log(harness, sid):
    """The session's codex.log: its app-servers' stderr."""
    return (harness.office.paths.run_dir(sid) / "codex.log").read_text()


def start(harness, workspace, by="ngocbh"):
    """Start minh's Codex session in ``workspace`` as ``by``; wait for its load."""
    sid = harness.start_session("minh", str(workspace), "codex", opened_by=by).id
    wait_for(lambda: status(harness, sid) == "idle", what="the Codex session to load")
    return sid

"""One run's page from its real Yian log: the header, log states, nodes, records and the download, all scrubbed."""

import builtins
import threading

import pytest

from opencorp.protocol import now
from opencorp.runs import reader as reader_mod
from opencorp.runs import service as service_mod
from opencorp.runs.known import KnownValues
from opencorp.runs.reader import RunLogReader
from opencorp.runs.service import RunLogs
from opencorp.store import RunRow, new_id
from opencorp.testing.fake_llm import LLM_CONFIG
from tests.chat.conftest import status, texts, wait_for
from tests.runs.logs import line

KEY = "conn-key-5f3a9c1e7b2d4a60"  # no provider shape: only the known-values step can catch it


def run_logs(harness):
    """Run Logs over the test harness's office, as build_office wires it."""
    harness.office.extras = {"harness": harness}
    return RunLogs(harness.office, known=KnownValues(connections=harness.connections,
                                                     secrets=harness.monitor.secrets, git=harness.git))


def chat(harness, fake_llm, workspace, reply="Hello."):
    """Start a chat and take one turn; return (session id, run id)."""
    fake_llm.script({"content": reply, "usage": {"prompt_tokens": 6, "completion_tokens": 1}})
    sid = harness.start_session("minh", str(workspace)).id
    wait_for(lambda: status(harness, sid) == "idle", what="the first turn")
    harness.prompt(sid, "hi")
    wait_for(lambda: texts(harness, sid) == [reply] and status(harness, sid) == "idle", what="the reply")
    return sid, harness.store.get_session(sid).run_ids[-1]


def a_row(harness, sid, **over):
    row = RunRow(**{"run_id": new_id(), "session_id": sid, "flow": "chat", "flow_path": "shared/flows/chat.yaml",
                    "driver": "ngocbh", "parent_run_id": None, "launched_at": now(), **over})
    return harness.store.add_run(row)


def unreadable(harness, runs, workspace):
    """A run whose log is one schema-8 line."""
    row = a_row(harness, harness.start_session("minh", str(workspace)).id)
    path = runs.log_path(row)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(line(0, "run_started", {}, schema=8))
    return row


def slow_refresh(monkeypatch, gate):
    """Make every index build report 1 of 4 MB read, then wait for ``gate``."""
    real = reader_mod.refresh

    def slow(path, index, *, progress=None):
        progress(1 << 20, 4 << 20)
        gate.wait(5)
        return real(path, index, progress=progress)

    monkeypatch.setattr(reader_mod, "refresh", slow)
    monkeypatch.setattr(service_mod, "INDEX_WAIT_S", 0.1)


async def test_a_chats_page_has_what_its_log_and_the_store_say(harness, fake_llm, workspace):
    sid, run_id = chat(harness, fake_llm, workspace)
    detail = await run_logs(harness).detail(run_id)
    assert (detail.log_state, detail.learnable, detail.repo_commit) == (
        "ok", True, harness.store.get_session(sid).repo_commit)
    assert len(detail.flow_fingerprint) == 64 and detail.models.get("chat/reply") == "stub"
    assert detail.usage.input_tokens == 6 and detail.run.status == "idle" and detail.parent is None


async def test_a_debrief_has_no_usage_recorded(harness, workspace):
    sid = harness.start_session("minh", str(workspace)).id
    row = a_row(harness, sid, flow="debrief", flow_path="shared/flows/debrief.yaml", driver="office")
    assert (await run_logs(harness).detail(row.run_id)).usage is None


async def test_a_run_with_no_log_says_whether_it_started(harness, workspace):
    sid = harness.start_session("minh", str(workspace)).id
    ended, still_open = a_row(harness, sid), a_row(harness, sid)
    harness.store.end_run(ended.run_id, "failed", reason="couldn't start")
    runs = run_logs(harness)
    got = await runs.detail(ended.run_id)
    assert (got.log_state, got.log_message) == ("not_started", "no run log: the run didn't start")
    assert (await runs.detail(still_open.run_id)).log_message == "not started yet"


async def test_a_log_this_office_cant_read_says_so(harness, workspace):
    runs = run_logs(harness)
    got = await runs.detail(unreadable(harness, runs, workspace).run_id)
    assert (got.log_state, got.log_message) == (
        "unsupported_schema", "This log uses run-log schema 8, which is older than this office supports")


async def test_a_first_read_of_a_large_log_answers_indexing(harness, fake_llm, workspace, monkeypatch):
    _, run_id = chat(harness, fake_llm, workspace)
    gate = threading.Event()
    slow_refresh(monkeypatch, gate)
    runs = run_logs(harness)
    got = await runs.detail(run_id)
    assert (got.log_state, got.bytes_done, got.bytes_total) == ("indexing", 1 << 20, 4 << 20)
    assert got.log_message == "reading the log: 1 of 4 MB"
    gate.set()
    monkeypatch.setattr(service_mod, "INDEX_WAIT_S", 5)
    assert (await runs.detail(run_id)).log_state == "ok"


async def test_reasons_in_the_header_parent_and_children_lose_known_values(make_harness, fake_llm, workspace):
    harness = make_harness(llm_config={**LLM_CONFIG, "api_key": KEY})
    sid, run_id = chat(harness, fake_llm, workspace)
    kid = a_row(harness, sid, parent_run_id=run_id)
    harness.store.end_run(kid.run_id, "failed", reason=f"401 for {KEY}")  # stored as given
    runs = run_logs(harness)
    head, child = await runs.detail(run_id), await runs.detail(kid.run_id)
    assert head.run.children[0].reason == "401 for [redacted]"
    assert child.run.reason == "401 for [redacted]" and child.parent.run_id == run_id


async def test_the_list_never_opens_a_log(harness, fake_llm, workspace, monkeypatch):
    chat(harness, fake_llm, workspace)
    real_open = builtins.open

    def guarded(file, *args, **kwargs):
        assert not str(file).endswith(".jsonl"), "the list opened a run log"
        return real_open(file, *args, **kwargs)

    for name in ("index", "ready"):
        monkeypatch.setattr(RunLogReader, name, lambda *a, **k: pytest.fail("the list asked the reader"))
    monkeypatch.setattr(reader_mod, "refresh", lambda *a, **k: pytest.fail("the list read a run log"))
    monkeypatch.setattr(builtins, "open", guarded)
    assert (await run_logs(harness).page()).runs[0].status == "idle"

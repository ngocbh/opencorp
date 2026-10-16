"""A Codex session the owner drives: load, turns, steers, interrupts, end, office stop."""

import time

import pytest

from agent_corp.chat.harness import HarnessError
from agent_corp.harness.codex import CodexStartError, owner_load
from agent_corp.protocol.models import HarnessPolicy
from agent_corp.worker.reaper import start_time
from tests.harness.conftest import errors, requests_valid, start, status, wait_for


class Live:
    """What ``CodexSessions.launch`` needs of a session."""

    def __init__(self, session_id, cwd, stopped=False):
        self.session_id, self.cwd, self.stopped, self.launching = session_id, cwd, stopped, None

    def launching_as(self, process):
        if not self.stopped:
            self.launching = process
        return not self.stopped

    def notified(self, *args):
        pass

    requested = exited = notified


def test_launch_registers_the_app_server_before_it_starts_and_refuses_once_stopped(harness, workspace):
    live = Live("S1", str(workspace))
    process = harness.codex.launch(live)
    assert live.launching is process and process.alive
    assert [r.session_id for r in harness.store.list_workers()] == ["harness:S1"]
    process.close(grace=1)
    with pytest.raises(CodexStartError):
        harness.codex.launch(Live("S2", str(workspace), stopped=True))
    assert harness.store.list_workers() == []


def test_a_codex_session_starts_with_an_owner_load(harness, fake_codex, workspace):
    sid = start(harness, workspace)
    s = harness.store.get_session(sid)
    assert (s.harness, s.kind, s.harness_session_id, s.harness_model) == ("codex", "main", "thr_1", "gpt-5.5-codex")
    assert s.work_item_id and s.connection == "office"  # the debrief's model, chosen as for a composer chat
    [init] = fake_codex.calls("initialize")
    assert init["capabilities"] == {"experimentalApi": True}
    assert fake_codex.calls("thread/start") == [owner_load(s.cwd, HarnessPolicy(sandbox="workspace-write"))]
    assert [r.session_id for r in harness.store.list_workers()] == [f"harness:{sid}"]
    requests_valid(fake_codex)


def test_a_codex_session_that_cant_be_set_up_fails_at_once(harness, workspace, monkeypatch):
    def broken(session):
        raise RuntimeError("sentinel")
    monkeypatch.setattr(harness.codex, "opener", broken)
    with pytest.raises(HarnessError) as e:
        harness.start_session("minh", str(workspace), "codex")  # opened_by None: the opener is looked up
    assert (e.value.status, e.value.code) == (500, "start_failed")
    [s] = harness.store.list_sessions()
    assert s.status == "failed"


def test_a_load_codex_refuses_fails_the_session_with_why(harness, fake_codex, workspace):
    fake_codex.script(initialize_error={"code": -32600, "message": "nope"}, stderr="config.toml: bad key")
    ended = []
    harness.hooks.session_ended.append(lambda s: ended.append(s.status))
    sid = harness.start_session("minh", str(workspace), "codex").id
    wait_for(lambda: status(harness, sid) == "failed", what="failed")
    assert "config.toml: bad key" in errors(harness, sid)[0] and harness.store.list_workers() == []
    assert ended == ["failed"]


def test_office_stop_kills_app_servers_stops_their_threads_and_keeps_statuses(harness, fake_codex, workspace):
    sid = start(harness, workspace)
    pid = harness.store.list_workers()[0].pid
    live = harness.codex._live[sid]
    harness.close_all()
    assert start_time(pid) is None and harness.store.list_workers() == [] and status(harness, sid) == "idle"
    assert not live._thread.is_alive()


def test_office_stop_during_a_load_kills_the_starting_app_server_and_writes_nothing(harness, fake_codex,
                                                                                    workspace):
    fake_codex.script(initialize_delay=1.5)
    sid = harness.start_session("minh", str(workspace), "codex", opened_by="ngocbh").id
    [record] = wait_for(lambda: harness.store.list_workers(), what="the app-server to spawn")
    harness.close_all()
    assert harness.store.list_workers() == [] and start_time(record.pid) is None
    time.sleep(2)  # past the end of the handshake the fake was holding
    assert (status(harness, sid), harness.store.list_workers(), errors(harness, sid)) == ("starting", [], [])


def test_a_codex_chat_started_after_office_stop_starts_nothing(harness, fake_codex, workspace):
    harness.close_all()
    sid = harness.start_session("minh", str(workspace), "codex", opened_by="ngocbh").id
    time.sleep(1)
    assert (status(harness, sid), harness.store.list_workers(), fake_codex.messages()) == ("starting", [], [])

"""A Codex session the owner drives: load, turns, steers, interrupts, end, office stop."""

import threading
import time

import pytest

from agent_corp.chat.harness import HarnessError
from agent_corp.harness import session as session_module
from agent_corp.harness.codex import CodexStartError, owner_load
from agent_corp.harness.rpc import JsonRpc, RpcClosed
from agent_corp.protocol.models import HarnessPolicy
from agent_corp.testing import fake_codex as fc
from agent_corp.worker.reaper import start_time
from tests.harness.conftest import errors, requests_valid, start, status, texts, wait_for


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


def test_a_message_is_a_turn_whose_reply_streams_into_the_transcript(harness, fake_codex, workspace):
    fake_codex.script([fc.agent_message("m1", "Hello there")])
    sid = start(harness, workspace)
    assert harness.prompt(sid, "hi", by="ngocbh") == "turn"
    wait_for(lambda: texts(harness, sid) == ["Hello there"] and status(harness, sid) == "idle", what="the reply")
    [user] = [m for m in harness.store.list_messages(sid) if m.role == "user"]
    assert user.author == "ngocbh"
    assert fake_codex.calls("turn/start")[0]["input"] == [{"type": "text", "text": "hi", "text_elements": []}]
    requests_valid(fake_codex)


def test_a_message_with_no_sender_is_the_openers(harness, fake_codex, workspace):
    sid = start(harness, workspace, by="lan")
    harness.prompt(sid, "hi")
    [user] = [m for m in harness.store.list_messages(sid) if m.role == "user"]
    assert user.author == "lan"


def test_a_message_during_a_turn_steers_it(harness, fake_codex, workspace):
    fake_codex.script([[{"sleep": 1}, *fc.agent_message("m1", "Done")]])
    sid = start(harness, workspace)
    harness.prompt(sid, "count")
    wait_for(lambda: status(harness, sid) == "busy", what="the turn to start")
    assert harness.steer(sid, "and stop at 5") == "steer"
    wait_for(lambda: status(harness, sid) == "idle", what="the turn's end")
    assert len(fake_codex.calls("turn/start")) == 2
    assert sum(1 for m in fake_codex.messages("out") if m.get("method") == "turn/started") == 1


def test_a_steer_while_a_command_runs_keeps_the_command_in_its_message(harness, fake_codex, workspace):
    fake_codex.script([[fc.command_started("c1", "sleep 1"), {"sleep": 1}, fc.command("c1", "sleep 1")[1],
                        *fc.agent_message("m1", "Slept, and stopping.")]])
    sid = start(harness, workspace)
    harness.prompt(sid, "sleep", by="ngocbh")
    wait_for(lambda: any(p.type == "tool" for m in harness.store.list_messages(sid) for p in m.parts),
             what="the running command")
    assert harness.prompt(sid, "then stop", by="ngocbh") == "steer"
    wait_for(lambda: status(harness, sid) == "idle", what="the turn's end")
    got = [(m.role, [p.text if p.type == "text" else p.state for p in m.parts])
           for m in harness.store.list_messages(sid)]
    assert got == [("user", ["sleep"]), ("assistant", ["completed"]), ("user", ["then stop"]),
                   ("assistant", ["Slept, and stopping."])]


def test_a_message_a_prompt_check_refuses_is_422(harness, fake_codex, workspace):
    sid = start(harness, workspace)
    harness.hooks.prompt_check.append(lambda session, text: "no secrets" if "sk-" in text else None)
    with pytest.raises(HarnessError) as e:
        harness.prompt(sid, "sk-123")
    assert (e.value.status, e.value.code) == (422, "refused") and fake_codex.calls("turn/start") == []


def test_a_message_codex_refuses_leaves_the_session_idle(harness, fake_codex, workspace, monkeypatch):
    sid = start(harness, workspace)

    def gone(*args, **kwargs):
        raise RpcClosed("the app-server is gone")
    monkeypatch.setattr(harness.codex._live[sid].process.rpc, "request", gone)
    with pytest.raises(HarnessError) as e:
        harness.prompt(sid, "hi")
    assert e.value.code == "codex_refused" and status(harness, sid) == "idle"


def test_office_stop_never_waits_on_a_message_codex_is_slow_to_take(harness, fake_codex, workspace, monkeypatch):
    sid = start(harness, workspace)
    release = threading.Event()

    def slow(*args, **kwargs):
        release.wait(30)
        raise RpcClosed("the app-server was killed")  # what office stop does to a request in flight
    monkeypatch.setattr(harness.codex._live[sid].process.rpc, "request", slow)
    refused = []  # a failure on the sender's thread would only warn, so the thread hands its outcome back

    def send():
        try:
            harness.prompt(sid, "hi")
            refused.append("sent")
        except HarnessError as e:
            refused.append(e.code)
    sender = threading.Thread(target=send)
    sender.start()
    wait_for(lambda: len([m for m in harness.store.list_messages(sid) if m.role == "user"]) == 1, what="the message")
    began = time.monotonic()
    harness.close_all()
    assert time.monotonic() - began < 5 and harness.store.list_workers() == []
    release.set()
    sender.join(5)
    assert not sender.is_alive() and refused == ["codex_refused"]


def test_a_message_while_loading_waits_for_the_load(harness, fake_codex, workspace):
    fake_codex.script([fc.agent_message("m1", "Got it")], initialize_delay=1)
    sid = harness.start_session("minh", str(workspace), "codex", opened_by="ngocbh").id
    assert harness.prompt(sid, "early") == "queued"
    assert harness.prompt(sid, "and then") == "queued"
    wait_for(lambda: texts(harness, sid) == ["Got it"], what="the queued message's reply")
    assert [p["input"][0]["text"] for p in fake_codex.calls("turn/start")] == ["early\n\nand then"]


def test_a_message_codex_never_answers_is_refused_and_leaves_the_session_idle(harness, fake_codex, workspace,
                                                                              monkeypatch):
    sid = start(harness, workspace)

    def hangs(*args, **kwargs):
        raise TimeoutError("turn/start got no answer in 60s")
    monkeypatch.setattr(harness.codex._live[sid].process.rpc, "request", hangs)
    with pytest.raises(HarnessError) as e:
        harness.prompt(sid, "hi")
    assert e.value.code == "codex_refused" and status(harness, sid) == "idle"


def test_a_queued_message_codex_never_answers_leaves_the_session_idle(harness, fake_codex, workspace, monkeypatch):
    fake_codex.script(initialize_delay=0.5)
    real = JsonRpc.request

    def hangs(self, method, params=None, **kwargs):
        if method == "turn/start":
            raise TimeoutError("turn/start got no answer in 60s")
        return real(self, method, params, **kwargs)
    monkeypatch.setattr(JsonRpc, "request", hangs)
    sid = harness.start_session("minh", str(workspace), "codex", opened_by="ngocbh").id
    assert harness.prompt(sid, "early") == "queued"
    wait_for(lambda: status(harness, sid) == "idle" and errors(harness, sid), what="the refusal")
    assert "didn't take the message" in errors(harness, sid)[0]


def test_office_stop_mid_reply_stores_all_its_text_with_the_marker(harness, fake_codex, workspace):
    fake_codex.script([[fc.agent_message("m1", "Hello there, friend")[0], fc.agent_message_delta("m1", "Hello "),
                        fc.agent_message_delta("m1", "there, "), fc.agent_message_delta("m1", "friend"),
                        {"sleep": 30}]])
    sid = start(harness, workspace)
    harness.prompt(sid, "go", by="ngocbh")
    wait_for(lambda: [e.data["text"] for e in harness.office.bus.events if e.type == "part.delta"][-1:] == ["friend"],
             what="the third delta")
    harness.close_all()
    assert texts(harness, sid) == ["Hello there, friend\n\n[interrupted]"] and status(harness, sid) == "busy"


def test_office_stop_leaves_the_transcript_to_a_thread_still_busy(harness, fake_codex, workspace, monkeypatch):
    sid = start(harness, workspace)
    live = harness.codex._live[sid]
    monkeypatch.setattr(session_module, "STOP_WAIT", 0.2)
    aborted, began, release = [], threading.Event(), threading.Event()
    monkeypatch.setattr(live.transcript, "abort", lambda: aborted.append(True))

    def hold():  # a job that outlasts the stop's wait
        began.set()
        release.wait(5)
    live._post(hold)
    assert began.wait(5)  # running, so the stop can't skip it
    harness.close_all()
    release.set()
    live._thread.join(5)
    assert aborted == [] and not live._thread.is_alive()


def test_esc_interrupts_the_turn_and_marks_it(harness, fake_codex, workspace):
    fake_codex.script([[fc.command_started("c1", "sleep 30"), {"sleep": 30}]])
    sid = start(harness, workspace)
    harness.prompt(sid, "sleep")
    wait_for(lambda: status(harness, sid) == "busy", what="the turn to start")
    wait_for(lambda: any(p.type == "tool" for m in harness.store.list_messages(sid) for p in m.parts),
             what="the running command")
    harness.interrupt(sid)
    wait_for(lambda: status(harness, sid) == "idle", what="the interrupted turn's end")
    assert fake_codex.calls("turn/interrupt") == [{"threadId": "thr_1", "turnId": "turn_1"}]
    parts = [p for m in harness.store.list_messages(sid) for p in m.parts]
    assert parts[1].state == "interrupted" and parts[-1].text.endswith("[interrupted]")  # parts[0] is "sleep"


def test_esc_with_no_turn_running_asks_codex_nothing(harness, fake_codex, workspace):
    sid = start(harness, workspace)
    harness.interrupt(sid)
    assert fake_codex.calls("turn/interrupt") == [] and status(harness, sid) == "idle"


def test_esc_on_a_codex_that_doesnt_answer_returns(harness, fake_codex, workspace, monkeypatch):
    fake_codex.script([[{"sleep": 30}]])
    sid = start(harness, workspace)
    harness.prompt(sid, "work")
    wait_for(lambda: status(harness, sid) == "busy", what="the turn to start")

    def hangs(*args, **kwargs):
        raise TimeoutError("turn/interrupt got no answer in 60s")
    monkeypatch.setattr(harness.codex._live[sid].process.rpc, "request", hangs)
    harness.interrupt(sid)  # no 500: ending the session or office stop kills a Codex that hangs

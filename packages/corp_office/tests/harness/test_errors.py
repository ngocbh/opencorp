"""Codex that can't start, errors, a dead app-server, an unloaded thread, token counts."""

import threading
import time

from agent_corp.harness import session as session_module
from agent_corp.harness.rpc import RpcError
from agent_corp.harness.session import usage_base
from agent_corp.harness.sessions import CodexSessions
from agent_corp.testing import fake_codex as fc
from agent_corp.worker.reaper import start_time
from agent_corp.worker.spawn import worker_env
from tests.harness.conftest import CODEX_PERSON, errors, requests_valid, start, status, texts, wait_for
from tests.store.conftest import session

WRITER_LOCK = {"code": -32600, "message": "thread 01a1456b-695d-7440-bc59-6b401d4bb3ea already has an active writer"}
"""What Codex answered the spike's thread/resume of a thread another app-server had loaded."""


def test_codex_missing_fails_the_session_and_says_what_to_do(make_harness, workspace, tmp_path):
    # Only the app-server's environment lacks codex: the office's own PATH, and its git, stay as they are.
    h = make_harness(files=CODEX_PERSON, codex=lambda office, hooks: CodexSessions(
        office, hooks, env=lambda: {**worker_env(), "PATH": str(tmp_path / "no-codex-here")}))
    sid = h.start_session("minh", str(workspace), "codex").id
    wait_for(lambda: status(h, sid) == "failed", what="failed")
    assert "isn't installed" in errors(h, sid)[0] and h.store.list_workers() == []


def test_a_signed_out_codex_fails_the_session_and_says_to_sign_in(harness, fake_codex, workspace):
    fake_codex.script(account=None)
    sid = harness.start_session("minh", str(workspace), "codex").id
    wait_for(lambda: status(harness, sid) == "failed", what="failed")
    assert "codex login" in errors(harness, sid)[0] and harness.store.list_workers() == []


def test_an_error_that_codex_retries_is_only_logged_and_one_it_doesnt_is_shown(harness, fake_codex, workspace):
    fake_codex.script([[fc.error("rate limited, retrying", will_retry=True), fc.error("stream broke", will_retry=False),
                        {"end": "failed", "error": {"message": "usage limit reached"}}]])
    sid = start(harness, workspace)
    harness.prompt(sid, "go")
    wait_for(lambda: status(harness, sid) == "idle" and len(errors(harness, sid)) == 2, what="two errors")
    assert errors(harness, sid) == ["Codex: stream broke", "Codex's turn failed: usage limit reached"]


def test_a_failed_turn_repeating_the_error_shown_shows_it_once(harness, fake_codex, workspace):
    fake_codex.script([[fc.error("usage limit reached", will_retry=False),
                        {"end": "failed", "error": {"message": "usage limit reached"}}]])
    sid = start(harness, workspace)
    harness.prompt(sid, "go")
    wait_for(lambda: status(harness, sid) == "idle" and errors(harness, sid), what="the error")
    assert errors(harness, sid) == ["Codex: usage limit reached"]


def test_a_dead_app_server_leaves_the_session_idle_and_the_next_message_reloads_the_thread(harness, fake_codex,
                                                                                          workspace):
    fake_codex.script([[*fc.agent_message("m1", "Working")[:2], fc.command_approval(1, "c1", "x", wait=False),
                        {"sleep": 0.3}, {"spawn": 300}, {"exit": 1}], fc.agent_message("m2", "Back again")],
                      stderr="panic: oops")
    sid = start(harness, workspace)
    harness.prompt(sid, "go")
    wait_for(lambda: any("Codex stopped" in e for e in errors(harness, sid)) and status(harness, sid) == "idle",
             what="the crash handled")
    assert "panic: oops" in errors(harness, sid)[0]
    assert [q.status for q in harness.store.list_questions(session_id=sid)] == ["stale"]
    assert texts(harness, sid)[-1].endswith("[interrupted]")
    [child] = fake_codex.spawned()  # a command the dead app-server left running
    wait_for(lambda: start_time(child) is None, what="the command child killed with the group")
    assert harness.store.list_workers() == []
    assert harness.prompt(sid, "again") == "queued"
    wait_for(lambda: "Back again" in texts(harness, sid), what="the reloaded turn")
    [resume] = fake_codex.calls("thread/resume")
    assert resume["threadId"] == "thr_1" and resume["approvalPolicy"] == "on-request" and resume["excludeTurns"]
    assert len(fake_codex.calls("initialize")) == 2
    assert [r.session_id for r in harness.store.list_workers()] == [f"harness:{sid}"]  # the new one's record
    requests_valid(fake_codex)


def test_ending_after_a_crash_without_a_reload_leaves_no_record_or_children(harness, fake_codex, workspace):
    fake_codex.script([[{"spawn": 300}, {"exit": 1}]])
    sid = start(harness, workspace)
    seen = []
    harness.hooks.end_status.append(lambda s: seen.append(harness.store.list_workers()) or None)
    harness.prompt(sid, "go")
    wait_for(lambda: errors(harness, sid) and status(harness, sid) == "idle", what="the crash handled")
    harness.end(sid)
    wait_for(lambda: status(harness, sid) == "ended", what="the end")
    [child] = fake_codex.spawned()
    assert seen == [[]] and harness.store.list_workers() == [] and start_time(child) is None


def test_a_reload_codex_refuses_leaves_the_session_idle_with_why(harness, fake_codex, workspace):
    fake_codex.script([[{"exit": 1}]])
    sid = start(harness, workspace)
    harness.prompt(sid, "go")
    wait_for(lambda: errors(harness, sid) and status(harness, sid) == "idle", what="the crash handled")
    fake_codex.script(resume_error={"code": -32600, "message": "no rollout found"})
    assert harness.prompt(sid, "again") == "queued"
    wait_for(lambda: len(errors(harness, sid)) == 2, what="the refused reload")
    assert "no rollout found" in errors(harness, sid)[1] and status(harness, sid) == "idle"
    assert harness.store.list_workers() == []
    fake_codex.script([[], fc.agent_message("m1", "Third time")])  # the fake's turn count goes on: this is turn 2
    assert harness.prompt(sid, "and again") == "queued"
    wait_for(lambda: "Third time" in texts(harness, sid), what="the next reload's turn")


def test_an_unloaded_thread_is_reloaded_by_the_next_message(harness, fake_codex, workspace):
    fake_codex.script([[fc.thread_closed()], fc.agent_message("m1", "Reloaded")])
    sid = start(harness, workspace)
    harness.prompt(sid, "go")
    wait_for(lambda: status(harness, sid) == "idle" and not harness.store.list_workers(), what="the unload")
    assert errors(harness, sid) == []
    assert harness.prompt(sid, "again") == "queued"
    wait_for(lambda: "Reloaded" in texts(harness, sid), what="the reloaded turn")
    assert fake_codex.calls("thread/resume")[0]["threadId"] == "thr_1"


def test_a_message_codex_says_has_no_thread_reloads_it_first(harness, fake_codex, workspace, monkeypatch):
    fake_codex.script([fc.agent_message("m1", "Reloaded")])
    sid = start(harness, workspace)
    old = harness.codex._live[sid].process

    def unloaded(method, params=None, **kwargs):
        raise RpcError(-32600, "thread not found: thr_1")
    monkeypatch.setattr(old.rpc, "request", unloaded)
    assert harness.prompt(sid, "again") == "queued"
    wait_for(lambda: "Reloaded" in texts(harness, sid), what="the reloaded turn")
    assert fake_codex.calls("thread/resume")[0]["threadId"] == "thr_1"
    assert [r.session_id for r in harness.store.list_workers()] == [f"harness:{sid}"]
    assert start_time(old.pid) is None and errors(harness, sid) == []
    assert [m.parts[0].text for m in harness.store.list_messages(sid) if m.role == "user"] == ["again"]


def test_a_message_another_message_is_reloading_for_waits_for_that_reload(harness, fake_codex, workspace,
                                                                         monkeypatch):
    fake_codex.script([fc.agent_message("m1", "Both read")])
    sid = start(harness, workspace)
    live = harness.codex._live[sid]
    old, gate, entered = live.process, threading.Event(), []

    def unloaded(method, params=None, **kwargs):
        entered.append(method)
        gate.wait(10)  # both messages are inside turn/start on the old app-server before either hears back
        raise RpcError(-32600, "thread not found: thr_1")
    monkeypatch.setattr(old.rpc, "request", unloaded)
    got = []
    threads = [threading.Thread(target=lambda t=t: got.append(harness.prompt(sid, t))) for t in ("one", "two")]
    for t in threads:
        t.start()
    wait_for(lambda: len(entered) == 2, what="both messages sent")
    gate.set()
    for t in threads:
        t.join(10)
    assert got == ["queued", "queued"]
    wait_for(lambda: "Both read" in texts(harness, sid) and status(harness, sid) == "idle", what="the reloaded turn")
    [turn] = fake_codex.calls("turn/start")
    assert sorted(turn["input"][0]["text"].split("\n\n")) == ["one", "two"]


def test_a_thread_open_elsewhere_says_so_and_stays_idle(harness, fake_codex, workspace):
    fake_codex.script([[{"exit": 1}]], resume_error=WRITER_LOCK)
    sid = start(harness, workspace)
    harness.prompt(sid, "crash")
    wait_for(lambda: status(harness, sid) == "idle" and errors(harness, sid), what="crashed")
    harness.prompt(sid, "again")
    wait_for(lambda: any("open in another Codex window" in e for e in errors(harness, sid)), what="the lock message")
    assert status(harness, sid) == "idle" and harness.store.list_workers() == []


def test_token_counts_are_kept_on_the_session_and_never_priced(harness, fake_codex, workspace):
    fake_codex.script([[fc.token_usage(1200, 800, 90)]])
    sid = start(harness, workspace)
    harness.prompt(sid, "go")
    wait_for(lambda: harness.store.get_session(sid).harness_usage is not None, what="usage")
    s = harness.store.get_session(sid)
    assert s.harness_usage.model_dump() == {"input_tokens": 1200, "cached_input_tokens": 800, "output_tokens": 90}
    assert s.cost == 0 and harness.store.list_usage(sid) == []


def test_a_continued_session_counts_only_its_own_stretch(harness, fake_codex, workspace):
    fake_codex.script([[fc.token_usage(2000, 1000, 150)]])
    first = start(harness, workspace)
    harness.store.update_session(first, harness_usage={"input_tokens": 1200, "cached_input_tokens": 800,
                                                       "output_tokens": 90})
    harness.end(first)
    wait_for(lambda: status(harness, first) == "ended", what="ended")
    s = harness.store.get_session(first)
    # A continued stretch: a new row on the same thread, with the first as its parent.
    second = harness.store.create_session(session(person="minh", harness="codex", cwd=s.cwd, status="idle",
                                                  harness_session_id="thr_1", parent_session_id=first,
                                                  repo_commit=s.repo_commit))
    harness.codex.start(second, resume=True)
    wait_for(lambda: status(harness, second.id) == "idle", what="resumed")
    harness.prompt(second.id, "go")
    wait_for(lambda: harness.store.get_session(second.id).harness_usage is not None, what="usage")
    assert harness.store.get_session(second.id).harness_usage.model_dump() == {
        "input_tokens": 800, "cached_input_tokens": 200, "output_tokens": 60}


def test_the_usage_before_a_stretch_sums_every_earlier_stretch(harness):
    used = [{"input_tokens": 100, "cached_input_tokens": 10, "output_tokens": 1},
            None,  # a stretch Codex reported nothing for
            {"input_tokens": 200, "cached_input_tokens": 20, "output_tokens": 2}]
    parent = None
    for usage in used:
        parent = harness.store.create_session(session(harness="codex", harness_session_id="thr_1",
                                                      parent_session_id=parent and parent.id, harness_usage=usage))
    last = harness.store.create_session(session(harness="codex", harness_session_id="thr_1",
                                                parent_session_id=parent.id))
    assert usage_base(harness.store, last) == {"input_tokens": 300, "cached_input_tokens": 30, "output_tokens": 3}
    assert usage_base(harness.store, session(harness="codex")) == {"input_tokens": 0, "cached_input_tokens": 0,
                                                                   "output_tokens": 0}


def test_an_office_stop_while_a_crash_is_handled_writes_nothing_after_it(harness, fake_codex, workspace):
    fake_codex.script([[fc.command_started("c1", "sleep 60"), {"sleep": 0.5}, {"exit": 1}]])
    sid = start(harness, workspace)
    live = harness.codex._live[sid]
    process = live.process
    kill = process.kill

    def stopped_meanwhile():
        live.stopped = True  # as office stop sets it, before this job's writes
        kill()
    process.kill = stopped_meanwhile
    harness.prompt(sid, "go")
    wait_for(lambda: live.stopped, what="the crash")
    live._jobs.put(None)
    live._thread.join(5)
    assert errors(harness, sid) == [] and status(harness, sid) == "busy"  # left for restore
    assert [p.state for m in harness.store.list_messages(sid) for p in m.parts if p.type == "tool"] == ["running"]


def test_a_message_codex_says_has_no_thread_after_another_reloaded_it_goes_to_the_new_app_server(
        harness, fake_codex, workspace, monkeypatch):
    fake_codex.script([fc.agent_message("m1", "First"), fc.agent_message("m2", "Second")])
    sid = start(harness, workspace)
    live = harness.codex._live[sid]
    old, entered, gate = live.process, threading.Event(), threading.Event()

    def unloaded(method, params=None, **kwargs):
        if params["input"][0]["text"] == "two":
            entered.set()
            gate.wait(10)  # Codex answers this one only after the reload the other message started is done
        raise RpcError(-32600, "thread not found: thr_1")
    monkeypatch.setattr(old.rpc, "request", unloaded)
    late = threading.Thread(target=harness.prompt, args=(sid, "two"))
    late.start()
    assert entered.wait(10)
    assert harness.prompt(sid, "one") == "queued"
    wait_for(lambda: "First" in texts(harness, sid) and status(harness, sid) == "idle" and not live.loading,
             what="the reload and its turn")
    gate.set()
    late.join(10)
    wait_for(lambda: "Second" in texts(harness, sid), what="the late message's turn")
    assert [c["input"][0]["text"] for c in fake_codex.calls("turn/start")] == ["one", "two"]
    assert len(fake_codex.calls("initialize")) == 2


def test_a_message_codex_says_has_no_thread_while_the_session_ends_starts_no_load(harness, fake_codex, workspace,
                                                                                 monkeypatch):
    fake_codex.script([[{"sleep": 30}]])
    monkeypatch.setattr(session_module, "END_WAIT", 1.0)
    sid = start(harness, workspace)
    harness.prompt(sid, "work")
    wait_for(lambda: status(harness, sid) == "busy", what="busy")
    old, entered, gate = harness.codex._live[sid].process, threading.Event(), threading.Event()
    real = old.rpc.request

    def unloaded(method, params=None, **kwargs):
        if method == "turn/interrupt":
            return {}  # taken, but the turn runs on until END_WAIT closes the app-server
        if method != "turn/start":
            return real(method, params, **kwargs)
        entered.set()
        gate.wait(10)
        raise RpcError(-32600, "thread not found: thr_1")
    monkeypatch.setattr(old.rpc, "request", unloaded)
    steer = threading.Thread(target=harness.prompt, args=(sid, "steer"))
    steer.start()
    assert entered.wait(10)
    harness.end(sid)
    gate.set()
    steer.join(10)
    wait_for(lambda: status(harness, sid) == "ended", timeout=10, what="the end")
    assert len(fake_codex.calls("initialize")) == 1 and harness.store.list_workers() == []


def test_closing_the_app_server_of_an_unloaded_thread_never_holds_the_message_or_outlives_office_stop(
        harness, fake_codex, workspace, monkeypatch):
    sid = start(harness, workspace)
    live = harness.codex._live[sid]
    old, closing, release = live.process, threading.Event(), threading.Event()
    real_close = old.close

    def slow_close(grace):
        closing.set()
        release.wait(5)
        real_close(grace)

    def unloaded(method, params=None, **kwargs):
        raise RpcError(-32600, "thread not found: thr_1")
    monkeypatch.setattr(old, "close", slow_close)
    monkeypatch.setattr(old.rpc, "request", unloaded)
    monkeypatch.setattr(session_module, "STOP_WAIT", 0.2)
    began = time.monotonic()
    assert harness.prompt(sid, "again") == "queued"
    assert time.monotonic() - began < 2  # the close runs on the session's thread, not the request's
    assert closing.wait(5)
    harness.close_all()  # while the old app-server is still being closed
    assert harness.store.list_workers() == [] and start_time(old.pid) is None
    release.set()
    live._thread.join(10)
    assert harness.store.list_workers() == [] and len(fake_codex.calls("initialize")) == 1

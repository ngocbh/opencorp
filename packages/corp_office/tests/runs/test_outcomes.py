"""Every end path writes the run's outcome once, in the transaction of the write that makes the end visible."""

import json
import os
import signal

import pytest

from opencorp.chat.harness import HarnessError, _run_end
from opencorp.chat.provider import Provider
from opencorp.runs.outcomes import RunEnd
from opencorp.secrets import write_private
from opencorp.store import new_id
from opencorp.testing.fake_llm import LLM_CONFIG
from tests.chat.conftest import say, status, texts, wait_for
from tests.store.conftest import session as stored_session

KEY = "sk-outcome-key-0123456789"


def start(harness, workspace):
    session = harness.start_session("minh", str(workspace))
    wait_for(lambda: status(harness, session.id) == "idle", what="the first turn")
    return session.id


def rows(harness, sid):
    return harness.store.runs_of_session(sid)


def test_how_finish_ends_a_run():
    looped = {"type": "result", "status": "failed", "failure": {"cause_type": "LoopMaxExceeded", "node_id": "chat"}}
    assert _run_end("ended", looped, Provider(), None) == RunEnd("finished", "stopped at its loop limit")
    assert _run_end("ended", {"type": "result", "status": "succeeded"}, Provider(), None) == RunEnd("finished")
    assert _run_end("failed", None, Provider(), None) == RunEnd("failed", "worker stopped")
    assert _run_end("failed", None, Provider(), "couldn't start") == RunEnd("failed", "couldn't start")


def test_an_ended_chat_is_finished_with_its_end_time(harness, fake_llm, workspace):
    fake_llm.script({"content": "Done."})
    sid = start(harness, workspace)
    harness.prompt(sid, "hi")
    wait_for(lambda: texts(harness, sid) == ["Done."] and status(harness, sid) == "idle", what="the reply")
    harness.end(sid)
    wait_for(lambda: status(harness, sid) == "ended", what="the end")
    (row,) = rows(harness, sid)
    assert (row.outcome, row.reason) == ("finished", None) and row.ended_at >= row.launched_at


def test_a_failed_run_says_why_and_where_without_the_providers_key(make_harness, workspace):
    harness = make_harness(llm_config={**LLM_CONFIG, "api_key": KEY})
    sid = start(harness, workspace)
    harness._finish(harness._live[sid], "failed", {"type": "result", "status": "failed", "output": None, "failure": {
        "node_id": "chat#0/reply", "cause_type": "AuthError", "message": f"bad key {KEY}; sent Bearer abcdefgh12345"}})
    (row,) = rows(harness, sid)
    assert (row.outcome, row.failed_node) == ("failed", "chat#0/reply")
    assert row.reason == "AuthError: bad key [redacted]; sent Bearer abcdefgh12345"  # only the provider's key


def test_a_worker_that_cant_start_fails_its_run_with_couldnt_start(harness, workspace):
    (harness.office.paths.office / "provider.json").chmod(0o644)  # not private: the spawn can't read it
    with pytest.raises(HarnessError):
        harness.start_session("minh", str(workspace))
    (session,) = harness.store.list_sessions()
    (row,) = rows(harness, session.id)
    assert (row.outcome, row.reason, row.failed_node) == ("failed", "couldn't start", None)


def test_a_second_death_fails_the_run_with_worker_stopped(harness, workspace):
    sid = start(harness, workspace)
    harness._finish(harness._live[sid], "failed", None)
    assert (rows(harness, sid)[0].outcome, rows(harness, sid)[0].reason) == ("failed", "worker stopped")


def test_a_session_restore_cant_rebuild_fails_its_run(make_harness, workspace):
    first = make_harness()
    sid = start(first, workspace)
    first.close_all()
    first.store.update_session(sid, status="busy")  # it was mid-reply, so restore must resume it now
    second = make_harness()
    second.restorers["main"] = lambda session: (_ for _ in ()).throw(OSError("the pin is gone"))
    second.restore()
    (row,) = rows(second, sid)
    assert (status(second, sid), row.outcome, row.reason) == ("failed", "failed", "couldn't resume")


def test_a_restore_whose_resume_cant_spawn_fails_its_run_with_couldnt_resume(make_harness, workspace):
    first = make_harness()
    sid = start(first, workspace)
    first.close_all()
    first.store.update_session(sid, status="busy")
    second = make_harness()
    second.registry.spawn = lambda *a: (_ for _ in ()).throw(OSError("can't start the worker"))
    second.restore()
    (row,) = rows(second, sid)
    assert (status(second, sid), row.outcome, row.reason) == ("failed", "failed", "couldn't resume")


def test_a_wake_for_its_end_that_fails_fails_the_run_with_couldnt_resume(make_harness, workspace):
    first = make_harness()
    sid = start(first, workspace)
    first.close_all()
    second = make_harness()
    (second.office.paths.office / "provider.json").chmod(0o644)  # its wake can't resolve the connection
    with pytest.raises(HarnessError):
        second.end(sid)
    (row,) = rows(second, sid)
    assert (status(second, sid), row.outcome, row.reason) == ("failed", "failed", "couldn't resume")


def test_a_wake_that_fails_not_for_its_end_leaves_its_run_open(make_harness, workspace):
    first = make_harness()
    sid = start(first, workspace)
    first.close_all()
    second = make_harness()
    (second.office.paths.office / "provider.json").chmod(0o644)
    with pytest.raises(HarnessError):
        second.prompt(sid, "hi")
    assert (status(second, sid), rows(second, sid)[0].outcome) == ("idle", None)


def test_an_outcome_and_the_sessions_end_commit_together(harness, workspace, monkeypatch):
    sid = start(harness, workspace)
    live = harness._live[sid]
    monkeypatch.setattr(harness.store, "end_run", lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError):
        harness._finish(live, "failed", None)
    assert status(harness, sid) == "idle" and rows(harness, sid)[0].outcome is None


def rekey(harness, key):
    """Give office/provider.json the model key ``key``."""
    path = harness.office.paths.office / "provider.json"
    provider = json.loads(path.read_text())
    write_private(path, json.dumps({**provider, "llm_config": {**provider["llm_config"], "api_key": key}}).encode())


def test_a_failed_reply_fails_its_run_and_the_fresh_run_replaces_it(harness, fake_llm, workspace):
    fake_llm.script({"error": 500}, {"content": "Back."})
    sid = start(harness, workspace)
    harness.prompt(sid, "hi")
    wait_for(lambda: len(harness.store.get_session(sid).run_ids) == 2 and status(harness, sid) == "idle",
             what="the new run")
    old, new = rows(harness, sid)
    assert old.outcome == "failed" and old.failed_node.endswith("/reply") and old.reason
    assert (new.outcome, new.driver, new.parent_run_id, new.launched_at) == (None, old.driver, None, old.ended_at)


def test_a_provider_change_interrupts_the_run_it_replaces(harness, fake_llm, workspace):
    fake_llm.script({"content": "One."}, {"content": "Two."})
    sid = start(harness, workspace)
    rekey(harness, "sk-a-new-key-0123456789")
    harness.prompt(sid, "hi")
    wait_for(lambda: len(harness.store.get_session(sid).run_ids) == 2, what="the fresh run")
    old, new = rows(harness, sid)
    assert (old.outcome, old.reason, new.launched_at) == (
        "interrupted", "replaced by a fresh run on the new model", old.ended_at)


def test_a_wake_on_a_new_key_interrupts_the_old_run_because_the_office_stopped(make_harness, fake_llm, workspace):
    first = make_harness(llm_config={**LLM_CONFIG, "api_key": KEY})
    sid = start(first, workspace)
    first.close_all()
    second = make_harness(llm_config={**LLM_CONFIG, "api_key": "sk-another-key-0123456789"})
    second.restore()  # the idle session sleeps
    second.prompt(sid, "hi")  # its wake finds the key changed: a fresh run
    wait_for(lambda: len(second.store.get_session(sid).run_ids) == 2, what="the fresh run")
    old, _ = rows(second, sid)
    assert (old.outcome, old.reason) == ("interrupted", "the office stopped; a fresh run replaced it")


def test_a_crash_resume_on_a_new_key_says_the_worker_stopped(make_harness, fake_llm, workspace):
    harness = make_harness(llm_config={**LLM_CONFIG, "api_key": KEY})
    sid = start(harness, workspace)
    rekey(harness, "sk-another-key-0123456789")
    os.killpg(harness._live[sid].worker.pgid, signal.SIGKILL)
    wait_for(lambda: len(harness.store.get_session(sid).run_ids) == 2, what="the fresh run")
    old, _ = rows(harness, sid)
    assert (old.outcome, old.reason) == ("interrupted", "its worker stopped; a fresh run replaced it")


def test_a_fresh_run_that_never_started_couldnt_start_when_the_next_wake_replaces_it(make_harness, fake_llm,
                                                                                    workspace):
    fake_llm.script({"content": "b's reply"})
    first = make_harness(llm_config={**LLM_CONFIG, "api_key": KEY})
    sid = start(first, workspace)
    first.close_all()
    second = make_harness(llm_config={**LLM_CONFIG, "api_key": "sk-another-key-0123456789"})  # a fresh run
    spawn, calls = second.registry.spawn, []

    def once_bad(*args):
        calls.append(1)
        if len(calls) == 1:
            raise OSError("can't start the worker")
        return spawn(*args)

    second.registry.spawn = once_bad
    with pytest.raises(HarnessError):
        second.prompt(sid, "a")  # its fresh run is recorded, then can't spawn, so it has no log
    assert say(second, sid, "b") == "b's reply"
    a, b, c = rows(second, sid)
    assert [(r.outcome, r.reason) for r in (a, b, c)] == [
        ("interrupted", "the office stopped; a fresh run replaced it"), ("failed", "couldn't start"), (None, None)]
    assert (b.launched_at, c.launched_at) == (a.ended_at, b.ended_at)


def test_a_fresh_run_after_a_run_with_no_row_is_driven_by_the_opener(harness, fake_llm, workspace):
    s = harness.store.create_session(stored_session(cwd=os.path.realpath(workspace), repo_commit=harness.git.head(),
                                                    status="idle", opened_by="lan"))
    harness.store.add_session_run(s.id, new_id())  # launched before rows were written, and with no log
    harness.restore()
    fake_llm.script({"content": "Hi."})
    harness.prompt(s.id, "hello")  # the wake starts fresh: its run never started
    wait_for(lambda: len(harness.store.get_session(s.id).run_ids) == 2, what="the fresh run")
    (row,) = rows(harness, s.id)
    assert (row.driver, row.parent_run_id, row.outcome) == ("lan", None, None)

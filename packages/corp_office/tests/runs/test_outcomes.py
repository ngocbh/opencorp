"""Every end path writes the run's outcome once, in the transaction of the write that makes the end visible."""

import pytest

from opencorp.chat.harness import HarnessError, _run_end
from opencorp.chat.provider import Provider
from opencorp.runs.outcomes import RunEnd
from opencorp.testing.fake_llm import LLM_CONFIG
from tests.chat.conftest import status, texts, wait_for

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


def test_a_failed_run_says_why_and_where_without_the_key(make_harness, workspace):
    harness = make_harness(llm_config={**LLM_CONFIG, "api_key": KEY})
    sid = start(harness, workspace)
    harness._finish(harness._live[sid], "failed", {"type": "result", "status": "failed", "output": None, "failure": {
        "node_id": "chat#0/reply", "cause_type": "AuthError", "message": f"bad key {KEY}; sent Bearer abcdefgh12345"}})
    (row,) = rows(harness, sid)
    assert (row.outcome, row.failed_node) == ("failed", "chat#0/reply")
    assert row.reason == "AuthError: bad key [redacted]; sent Bearer (hidden)"  # its key, then every secret shape


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


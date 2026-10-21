"""Each launch path writes one row in runs, in the transaction that records the session's run; resumes write none."""

import os
import signal

import pytest

from opencorp.chat.harness import HarnessError
from tests.chat.conftest import spawned, status, wait_for


def start(harness, workspace, **kw):
    session = harness.start_session("minh", str(workspace), **kw)
    wait_for(lambda: status(harness, session.id) == "idle", what="the first turn")
    return session.id


def kill(harness, sid):
    """Kill the session's worker and wait for its replacement to reach a turn."""
    old = harness._live[sid].worker
    os.killpg(old.pgid, signal.SIGKILL)
    wait_for(lambda: sid in harness._live and harness._live[sid].worker not in (None, old)
             and harness._live[sid].turn_q, what="the worker after the kill")


def test_a_main_chat_writes_one_row_with_its_driver_and_flow(harness, workspace):
    sid = start(harness, workspace)
    (row,) = harness.store.runs_of_session(sid)
    assert row.run_id == harness.store.get_session(sid).run_ids[-1]
    assert (row.flow, row.flow_path, row.driver, row.parent_run_id, row.outcome) == (
        "chat", "shared/flows/chat.yaml", "ngocbh", None, None)


def test_the_opener_drives_the_run(harness, workspace):
    sid = start(harness, workspace, opened_by="lan")
    assert harness.store.runs_of_session(sid)[0].driver == "lan"


def test_a_start_whose_live_run_cant_be_built_records_no_run(harness, workspace, monkeypatch):
    monkeypatch.setattr(harness, "_new_live", lambda *a: (_ for _ in ()).throw(OSError("the pin is gone")))
    with pytest.raises(HarnessError):
        harness.start_session("minh", str(workspace))
    (session,) = harness.store.list_sessions()
    assert (session.status, session.run_ids, harness.store.runs_of_session(session.id)) == ("failed", [], [])


def test_a_start_that_loses_to_another_start_is_interrupted(harness, workspace):
    session = harness._open("minh", str(workspace), "composer", opened_by=None, connection=None, model=None)
    spec, add_run, other = harness.main_spec(session), harness.store.add_run, object()

    def and_another_start_wins(row):
        stored = add_run(row)
        harness._live[session.id] = other  # the other start took the lock first
        return stored

    harness.store.add_run = and_another_start_wins
    try:
        with pytest.raises(HarnessError) as err:
            harness.start_run(session, spec)
    finally:
        harness._live.pop(session.id, None)
    assert err.value.code == "live"
    (row,) = harness.store.runs_of_session(session.id)
    assert (row.outcome, row.reason) == ("interrupted", "another start of this session won")


def test_the_profile_manager_is_driven_by_who_opened_it(harness, fake_llm, learning):
    fake_llm.script({"content": "Noted."})
    session = learning.start_manager("minh", "tighten the profile", by="lan")
    (row,) = harness.store.runs_of_session(session.id)
    assert (row.flow, row.flow_path, row.driver, row.parent_run_id) == (
        "profile_manager", "shared/flows/profile_manager.yaml", "lan", None)


def test_a_resumed_run_writes_no_row(harness, workspace):
    sid = start(harness, workspace)
    jobs = spawned(harness, lambda job: job.kind)
    kill(harness, sid)
    assert jobs == ["resume"] and len(harness.store.runs_of_session(sid)) == 1

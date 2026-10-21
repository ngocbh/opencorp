"""Each launch path writes one row in runs, in the transaction that records the session's run; resumes write none."""

import os
import signal
import threading

import pytest

from opencorp.chat.harness import HarnessError
from tests.chat.conftest import spawned, status, wait_for
from tests.chat.test_wake import calling


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
    assert not harness._starting


def test_a_start_whose_run_cant_be_stored_lets_go_of_the_session(harness, workspace, monkeypatch):
    session = harness._open("minh", str(workspace), "composer", opened_by=None, connection=None, model=None)
    monkeypatch.setattr(harness.store, "add_run", lambda row: (_ for _ in ()).throw(OSError("the disk is full")))
    with pytest.raises(OSError):
        harness.start_run(session, harness.main_spec(session))
    stored = harness.store.get_session(session.id)
    assert (stored.status, stored.run_ids, harness.store.runs_of_session(session.id)) == ("failed", [], [])
    assert not harness._starting and session.id not in harness._live


@pytest.mark.parametrize("held_in", ["build", "store"])
def test_a_second_start_while_one_is_in_flight_gets_409_and_writes_nothing(harness, workspace, monkeypatch, held_in):
    session = harness._open("minh", str(workspace), "composer", opened_by=None, connection=None, model=None)
    spec, writes = harness.main_spec(session), []
    for name in ("add_session_run", "add_run", "end_run"):
        def write(*args, _real=getattr(harness.store, name), **kwargs):
            writes.append(threading.current_thread().name)
            return _real(*args, **kwargs)
        monkeypatch.setattr(harness.store, name, write)
    # The first start is held building its live run, or inside the transaction that stores its run.
    target, name = (harness, "_new_live") if held_in == "build" else (harness.store, "add_run")
    real, entered, release = getattr(target, name), threading.Event(), threading.Event()

    def held(*args):
        if not entered.is_set():
            entered.set()
            assert release.wait(10)
        return real(*args)

    monkeypatch.setattr(target, name, held)
    first, won = calling(harness.start_run, session, spec)
    try:
        assert entered.wait(10)
        second, lost = calling(harness.start_run, session, spec)
        second.join(5)  # at once: it never waits on the store
        assert lost == [(409, "live")]
    finally:
        release.set()
        first.join(30)
    (run_id,) = won
    wait_for(lambda: status(harness, session.id) == "idle", what="the first turn")
    (row,) = harness.store.runs_of_session(session.id)
    assert harness.store.get_session(session.id).run_ids == [run_id] == [harness._live[session.id].run_id]
    assert (row.run_id, row.outcome) == (run_id, None)
    assert set(writes) == {first.name} and not harness._starting


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

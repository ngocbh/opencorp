"""Run records: each chat run's connection and model, what a resume checks, and a removed connection."""

from pathlib import Path

import pytest

from agent_corp.chat import harness as harness_module
from agent_corp.chat.connections import OFFICE, ConnectionFile, config_hash, read_run_record
from agent_corp.chat.harness import HarnessError
from agent_corp.testing.fake_llm import LLM_CONFIG
from tests.chat.conftest import on, say, spawned, status, wait_for

KEY = "sk-record-test-0e7c"


def start(harness, workspace):
    session = harness.start_session("minh", str(workspace))
    wait_for(lambda: status(harness, session.id) == "idle", what="the first turn")
    return session.id


def record_of(harness, sid):
    """The run record of a session's latest run."""
    run_id = harness.store.get_session(sid).run_ids[-1]
    return read_run_record(harness.office.paths.run_dir(sid) / "runs" / f"{run_id}.model.json")


def model_of(request):
    return request["model"]


def test_each_new_run_has_a_record_before_its_worker_starts(make_harness, workspace):
    harness = make_harness(llm_config={**LLM_CONFIG, "api_key": KEY})

    def see(job):
        path = Path(job.log).with_suffix(".model.json")
        return job.kind, path.stat().st_mode & 0o777, KEY in path.read_text(), read_run_record(path)

    seen = spawned(harness, see)
    start(harness, workspace)
    ((kind, mode, leaked, record),) = seen
    assert (kind, mode, leaked) == ("chat", 0o600, False)
    assert (record.connection, record.model) == (OFFICE, None)
    assert record.config == config_hash(harness.connections.resolve(OFFICE, None))


def test_a_failed_record_write_fails_the_spawn(make_harness, workspace, monkeypatch):
    harness = make_harness()

    def unwritable(*args):
        raise OSError("disk full")

    monkeypatch.setattr(harness_module, "write_run_record", unwritable)
    jobs = spawned(harness)
    with pytest.raises(HarnessError) as err:
        harness.start_session("minh", str(workspace))
    (session,) = harness.store.list_sessions()
    assert (err.value.code, session.status, jobs) == ("start_failed", "failed", [])
    assert "failed to start" in err.value.message and session.id not in harness._live


def test_a_session_on_a_second_connection_runs_on_it(make_harness, fake_llm, workspace):
    harness = make_harness(connections={"second": "stub-2"})
    fake_llm.script({"content": "on two"})
    sid = start(harness, workspace)
    on(harness, sid, "second")
    assert say(harness, sid, "hi") == "on two"
    assert model_of(fake_llm.requests()[-1]) == "stub-2"
    assert (record_of(harness, sid).connection, record_of(harness, sid).model) == ("second", None)
    assert len(harness.store.get_session(sid).run_ids) == 2


def test_a_session_on_a_model_of_its_connection_runs_on_that_model(make_harness, fake_llm, workspace):
    harness = make_harness()
    fake_llm.script({"content": "on three"})
    sid = start(harness, workspace)
    on(harness, sid, OFFICE, "stub-3")
    assert say(harness, sid, "hi") == "on three"
    assert model_of(fake_llm.requests()[-1]) == "stub-3"
    assert (record_of(harness, sid).connection, record_of(harness, sid).model) == (OFFICE, "stub-3")


def test_a_removed_connection_moves_the_chat_to_the_default_on_its_next_turn(make_harness, fake_llm, workspace):
    harness = make_harness(connections={"second": "stub-2"})
    fake_llm.script({"content": "from two", "hold": True}, {"content": "from one"})
    sid = start(harness, workspace)
    on(harness, sid, "second")
    harness.prompt(sid, "a")
    fake_llm.wait_for_requests(1)
    harness.connections.remove("second")
    fake_llm.release()  # a running reply keeps the key it has
    wait_for(lambda: status(harness, sid) == "idle" and harness._live[sid].turn_q, what="the held reply")
    assert model_of(fake_llm.requests()[-1]) == "stub-2"

    assert say(harness, sid, "b") == "from one"
    assert model_of(fake_llm.requests()[-1]) == "stub"
    session = harness.store.get_session(sid)
    assert (session.connection, session.model) == (OFFICE, None)
    assert session.model_note == "Connection 'second' was removed; this chat now uses office/stub."
    assert record_of(harness, sid).connection == OFFICE


def test_the_key_change_on_the_same_name_restarts_on_the_next_turn(make_harness, fake_llm, workspace):
    harness = make_harness(connections={"second": "stub-2"})
    fake_llm.script({"content": "one"}, {"content": "two"})
    sid = start(harness, workspace)
    on(harness, sid, "second")
    say(harness, sid, "a")
    before = record_of(harness, sid)
    conn = harness.connections.get("second")
    harness.connections.put("second", ConnectionFile(llm_config={**conn.llm_config, "api_key": KEY}, env=conn.env))
    jobs = spawned(harness)
    assert say(harness, sid, "b") == "two"
    assert [(j.kind, j.llm_config["api_key"]) for j in jobs] == [("chat", KEY)]
    after = record_of(harness, sid)
    assert len(harness.store.get_session(sid).run_ids) == 3
    assert after.connection == "second" and after.config != before.config
    assert after.config == config_hash(harness.connections.resolve("second", None))

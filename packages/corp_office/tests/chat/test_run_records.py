"""Run records: each chat run's connection and model, what a resume checks, and a removed connection."""

import json
import os
import signal
from pathlib import Path

import pytest

from opencorp.chat import harness as harness_module
from opencorp.chat.connections import OFFICE, ConnectionFile, config_hash, read_run_record
from opencorp.chat.harness import HarnessError
from opencorp.secrets import write_private
from opencorp.testing.fake_llm import LLM_CONFIG
from tests.chat.conftest import errors, on, say, spawned, status, wait_for

KEY = "sk-record-test-0e7c"
FRESH = ("This chat continues on a fresh run because its model or connection changed. "
         "If your last message got no reply, send it again.")
REMOVED = "Connection 'second' was removed; this chat now uses office/stub."
WOKEN = "This chat continues on a fresh run because its model or connection changed."


def wake(harness, fake_llm, sid):
    """Wake a sleeping session with a message; wait for its reply and next turn."""
    fake_llm.script({"content": "woken"})
    return say(harness, sid, "wake up")


def start(harness, workspace):
    session = harness.start_session("minh", str(workspace))
    wait_for(lambda: status(harness, session.id) == "idle", what="the first turn")
    return session.id


def record_of(harness, sid):
    """The run record of a session's latest run."""
    run_id = harness.store.get_session(sid).run_ids[-1]
    return read_run_record(harness.office.paths.run_dir(sid) / "runs" / f"{run_id}.model.json")


def rewrite_office(harness, **llm):
    """Change office/provider.json's llm_config, as ``opencorp onboard`` would."""
    path = harness.office.paths.office / "provider.json"
    provider = json.loads(path.read_text())
    write_private(path, json.dumps({**provider, "llm_config": {**provider["llm_config"], **llm}}).encode())


def kill(harness, sid):
    """Kill the session's worker and wait for its replacement to reach a turn."""
    old = harness._live[sid].worker
    os.killpg(old.pgid, signal.SIGKILL)
    wait_for(lambda: sid in harness._live and harness._live[sid].worker not in (None, old)
             and harness._live[sid].turn_q, what="the worker after the kill")


def on_base_url(fake_llm):
    """An llm_config for the FakeLLM that names its endpoint as a base_url (which composer sends a key to)."""
    return {**LLM_CONFIG, "base_url": f"{fake_llm.base_url}/v1", "api_key": KEY}


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


def test_restore_resumes_a_run_whose_record_matches(make_harness, fake_llm, workspace):
    fake_llm.script({"content": "one"}, {"content": "two"})
    first = make_harness()
    sid = start(first, workspace)
    say(first, sid, "a")
    first.close_all()

    second = make_harness()
    jobs = spawned(second)
    second.restore()
    assert sid not in second._live
    assert say(second, sid, "b") == "two"
    assert [j.kind for j in jobs] == ["resume"]
    session = second.store.get_session(sid)
    assert (len(session.run_ids), session.model_note) == (1, None)


def test_restore_after_the_key_changed_starts_a_fresh_run_with_a_note(make_harness, fake_llm, workspace):
    first = make_harness(llm_config={**LLM_CONFIG, "api_key": KEY})
    sid = start(first, workspace)
    first.close_all()

    second = make_harness(llm_config={**LLM_CONFIG, "api_key": "sk-another-key"})
    jobs = spawned(second)
    seen = []
    second.store.add_listener(lambda e: seen.append(e.data.get("model_note")) if e.type == "session.updated" else None)
    second.restore()
    assert sid not in second._live
    wake(second, fake_llm, sid)
    assert [(j.kind, j.llm_config["api_key"]) for j in jobs] == [("chat", "sk-another-key")]
    session = second.store.get_session(sid)
    assert (len(session.run_ids), session.model_note) == (2, WOKEN)
    assert WOKEN in seen  # clients hear of it
    assert record_of(second, sid).config == config_hash(second.connections.resolve(OFFICE, None))


def test_restore_after_the_endpoint_changed_starts_a_fresh_run(make_harness, fake_llm, workspace):
    first = make_harness(llm_config={**LLM_CONFIG, "api_key": KEY})
    sid = start(first, workspace)
    first.close_all()

    second = make_harness(llm_config=on_base_url(fake_llm))
    jobs = spawned(second)
    second.restore()
    assert sid not in second._live
    wake(second, fake_llm, sid)
    assert [j.kind for j in jobs] == ["chat"]
    assert len(second.store.get_session(sid).run_ids) == 2


def test_restore_of_a_run_without_a_record_resumes_on_the_same_base_url(make_harness, fake_llm, workspace):
    fake_llm.script({"content": "one"}, {"content": "two"})
    first = make_harness()
    sid = start(first, workspace)
    say(first, sid, "a")
    first.close_all()
    run_id = first.store.get_session(sid).run_ids[-1]
    (first.office.paths.run_dir(sid) / "runs" / f"{run_id}.model.json").unlink()  # a run from before records

    second = make_harness()
    jobs = spawned(second)
    second.restore()
    assert sid not in second._live
    assert say(second, sid, "b") == "two"
    assert [j.kind for j in jobs] == ["resume"]
    assert second.store.get_session(sid).run_ids == [run_id]


def test_restore_of_a_run_without_a_record_on_another_base_url_starts_fresh(make_harness, fake_llm, workspace):
    first = make_harness()
    sid = start(first, workspace)
    first.close_all()
    run_id = first.store.get_session(sid).run_ids[-1]
    (first.office.paths.run_dir(sid) / "runs" / f"{run_id}.model.json").unlink()

    second = make_harness(llm_config=on_base_url(fake_llm))
    jobs = spawned(second)
    second.restore()
    assert sid not in second._live
    wake(second, fake_llm, sid)
    assert [j.kind for j in jobs] == ["chat"]
    assert second.store.get_session(sid).model_note == WOKEN


def test_a_crash_resume_checks_the_record_too(make_harness, fake_llm, workspace):
    harness = make_harness(llm_config={**LLM_CONFIG, "api_key": KEY})
    sid = start(harness, workspace)
    jobs = spawned(harness)
    rewrite_office(harness, api_key="sk-another-key")
    kill(harness, sid)
    assert [(j.kind, j.llm_config["api_key"]) for j in jobs] == [("chat", "sk-another-key")]
    session = harness.store.get_session(sid)
    assert (len(session.run_ids), session.model_note) == (2, FRESH)


def test_a_crash_resume_whose_record_matches_resumes(make_harness, fake_llm, workspace):
    harness = make_harness()
    sid = start(harness, workspace)
    jobs = spawned(harness)
    kill(harness, sid)
    assert [j.kind for j in jobs] == ["resume"]
    assert harness.store.get_session(sid).model_note is None


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
    assert session.model_note == REMOVED
    assert record_of(harness, sid).connection == OFFICE


def test_a_crash_resume_after_removal_moves_to_the_default(make_harness, fake_llm, workspace):
    harness = make_harness(connections={"second": "stub-2"})
    fake_llm.script({"content": "from two"})
    sid = start(harness, workspace)
    on(harness, sid, "second")
    say(harness, sid, "a")
    harness.connections.remove("second")
    jobs = spawned(harness)
    kill(harness, sid)
    assert [(j.kind, j.llm_config["model"]) for j in jobs] == [("chat", "stub")]
    session = harness.store.get_session(sid)
    assert (session.connection, session.model, len(session.run_ids)) == (OFFICE, None, 3)
    assert session.model_note == REMOVED  # says more than the fresh-run note
    assert record_of(harness, sid).connection == OFFICE
    assert errors(harness, sid) == []


def test_a_wake_after_removal_keeps_the_removal_note(make_harness, fake_llm, workspace):
    first = make_harness(connections={"second": "stub-2"})
    fake_llm.script({"content": "from two"}, {"content": "on office"})
    sid = start(first, workspace)
    on(first, sid, "second")
    say(first, sid, "a")
    first.close_all()
    first.connections.remove("second")

    second = make_harness()
    jobs = spawned(second)
    assert say(second, sid, "b") == "on office"  # the wake moves it to the default
    assert [(j.kind, j.llm_config["model"]) for j in jobs] == [("chat", "stub")]
    session = second.store.get_session(sid)
    # The wake's preflight is read-only, so _resume does the move: its note stays, not the fresh-run one.
    assert (session.connection, session.model_note) == (OFFICE, REMOVED)


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


def unrecord(harness, sid):
    """Delete the record of a session's latest run, as for a run from before records."""
    run_id = harness.store.get_session(sid).run_ids[-1]
    (harness.office.paths.run_dir(sid) / "runs" / f"{run_id}.model.json").unlink()


def test_restore_of_a_run_without_a_record_on_another_connection_starts_fresh_on_it(make_harness, fake_llm,
                                                                                     workspace):
    first = make_harness(connections={"second": "stub-2"})
    sid = start(first, workspace)
    first.close_all()
    unrecord(first, sid)
    on(first, sid, "second")

    second = make_harness()
    jobs = spawned(second)
    second.restore()
    assert sid not in second._live
    wake(second, fake_llm, sid)
    assert [(j.kind, j.llm_config["model"]) for j in jobs] == [("chat", "stub-2")]
    assert second.store.get_session(sid).model_note == WOKEN


def test_a_crash_resume_of_a_run_without_a_record_on_another_connection_starts_fresh_on_it(make_harness, fake_llm,
                                                                                            workspace):
    harness = make_harness(connections={"second": "stub-2"})
    sid = start(harness, workspace)
    unrecord(harness, sid)
    on(harness, sid, "second")
    jobs = spawned(harness)
    kill(harness, sid)
    assert [(j.kind, j.llm_config["model"]) for j in jobs] == [("chat", "stub-2")]


def test_restore_after_a_model_change_starts_a_fresh_run_on_it(make_harness, fake_llm, workspace):
    first = make_harness()
    sid = start(first, workspace)
    on(first, sid, OFFICE, "stub-3")
    first.close_all()

    second = make_harness()
    jobs = spawned(second)
    second.restore()
    assert sid not in second._live
    wake(second, fake_llm, sid)
    assert [(j.kind, j.llm_config["model"]) for j in jobs] == [("chat", "stub-3")]
    assert second.store.get_session(sid).model_note == WOKEN


def test_a_crash_resume_after_a_model_change_starts_a_fresh_run_on_it(make_harness, fake_llm, workspace):
    harness = make_harness()
    sid = start(harness, workspace)
    on(harness, sid, OFFICE, "stub-3")
    jobs = spawned(harness)
    kill(harness, sid)
    assert [(j.kind, j.llm_config["model"]) for j in jobs] == [("chat", "stub-3")]
    assert harness.store.get_session(sid).model_note == FRESH


def test_a_resume_runs_on_what_its_check_passed_even_if_the_choice_changes_meanwhile(make_harness, fake_llm,
                                                                                     workspace):
    harness = make_harness(connections={"second": "stub-2"})
    sid = start(harness, workspace)
    for_run = harness.connections.for_run

    def then_switch(*args, **kwargs):
        provider = for_run(*args, **kwargs)
        on(harness, sid, "second")  # a /model between the check and the spawn
        return provider

    harness.connections.for_run = then_switch
    jobs = spawned(harness)
    kill(harness, sid)
    assert [(j.kind, j.llm_config["model"]) for j in jobs] == [("resume", "stub")]


def announced(harness):
    """The run ids the harness's ``run_finished`` hook announces from now on, in order."""
    seen = []
    harness.hooks.run_finished.append(lambda session, run_id, outcome: seen.append(run_id))
    return seen


def killed(harness, sid):
    """Kill the session's worker."""
    os.killpg(harness._live[sid].worker.pgid, signal.SIGKILL)


def test_a_crash_resume_that_cant_read_where_the_chat_goes_fails_without_a_new_run(make_harness, fake_llm, workspace):
    harness = make_harness(connections={"second": "stub-2"})
    fake_llm.script({"content": "from two"})
    sid = start(harness, workspace)
    on(harness, sid, "second")
    say(harness, sid, "a")
    runs = harness.store.get_session(sid).run_ids
    harness.connections.remove("second")
    write_private(harness.connections.dir / "_default.json", b"{}")  # so the chat can't be moved
    killed(harness, sid)
    wait_for(lambda: status(harness, sid) == "failed", what="the failed session")
    session = harness.store.get_session(sid)
    assert (session.run_ids, session.model_note, session.connection) == (runs, None, "second")
    assert sid not in harness._live


def test_a_wake_whose_fresh_run_cant_be_recorded_answers_503_and_leaves_the_session_idle(make_harness, fake_llm,
                                                                                        workspace, monkeypatch):
    first = make_harness(llm_config={**LLM_CONFIG, "api_key": KEY})
    sid = start(first, workspace)
    first.close_all()

    second = make_harness(llm_config={**LLM_CONFIG, "api_key": "sk-another-key"})

    def unrecorded(*args):
        raise OSError("disk full")

    second.restore()
    monkeypatch.setattr(second.store, "add_session_run", unrecorded)
    with pytest.raises(HarnessError) as err:
        second.prompt(sid, "a")
    assert (err.value.status, err.value.code) == (503, "cant_wake")
    assert status(second, sid) == "idle" and sid not in second._live
    assert second.store.get_session(sid).run_ids == first.store.get_session(sid).run_ids
    assert [q.status for q in second.store.list_questions(session_id=sid)] == ["open"]  # its turn is still open


def test_a_fresh_run_that_cant_be_recorded_fails_the_session_after_a_crash(make_harness, fake_llm, workspace,
                                                                          monkeypatch):
    harness = make_harness(llm_config={**LLM_CONFIG, "api_key": KEY})
    sid = start(harness, workspace)
    rewrite_office(harness, api_key="sk-another-key")

    def unrecorded(*args):
        raise OSError("disk full")

    old = harness.store.get_session(sid).run_ids
    finished = announced(harness)
    monkeypatch.setattr(harness.store, "add_session_run", unrecorded)
    killed(harness, sid)
    wait_for(lambda: status(harness, sid) == "failed", what="the failed session")
    assert sid not in harness._live
    assert finished == old  # the run that died, once; never a run the session didn't record


def test_a_restart_that_cant_record_its_run_announces_the_old_run_once(make_harness, fake_llm, workspace,
                                                                       monkeypatch):
    harness = make_harness(llm_config={**LLM_CONFIG, "api_key": KEY})
    sid = start(harness, workspace)
    old = harness.store.get_session(sid).run_ids
    rewrite_office(harness, api_key="sk-another-key")
    finished = announced(harness)

    def unrecorded(*args):
        raise OSError("disk full")

    monkeypatch.setattr(harness.store, "add_session_run", unrecorded)
    harness.prompt(sid, "a")  # the key changed, so a fresh run would take it
    wait_for(lambda: status(harness, sid) == "failed", what="the failed session")
    assert finished == old and sid not in harness._live
    assert harness.store.get_session(sid).run_ids == old


def test_a_wake_whose_fresh_run_note_cant_be_written_answers_503_and_leaves_the_session_idle(make_harness,
                                                                                            fake_llm, workspace,
                                                                                            monkeypatch):
    first = make_harness(llm_config={**LLM_CONFIG, "api_key": KEY})
    sid = start(first, workspace)
    first.close_all()

    second = make_harness(llm_config={**LLM_CONFIG, "api_key": "sk-another-key"})
    update = second.store.update_session

    def no_notes(session_id, **fields):
        if "model_note" in fields:
            raise OSError("disk full")
        return update(session_id, **fields)

    second.restore()
    monkeypatch.setattr(second.store, "update_session", no_notes)
    with pytest.raises(HarnessError) as err:
        second.prompt(sid, "a")
    assert (err.value.status, err.value.code) == (503, "cant_wake")
    assert status(second, sid) == "idle" and sid not in second._live
    assert second.store.get_session(sid).run_ids == first.store.get_session(sid).run_ids


def test_a_removed_connection_stops_serving_turns_even_when_the_default_cant_be_used(make_harness, fake_llm,
                                                                                    workspace):
    harness = make_harness(connections={"second": "stub-2"})
    fake_llm.script({"content": "from two"}, {"content": "still from two"})
    sid = start(harness, workspace)
    on(harness, sid, "second")
    say(harness, sid, "a")
    n = len(fake_llm.requests())
    harness.connections.remove("second")
    (harness.office.paths.office / "provider.json").chmod(0o644)  # the default, office, refuses it
    harness.prompt(sid, "b")
    wait_for(lambda: status(harness, sid) == "failed", what="the failed session")
    assert len(fake_llm.requests()) == n  # the removed key sent nothing more
    session = harness.store.get_session(sid)
    assert session.model_note == "Connection 'second' was removed; this chat now uses office."
    assert errors(harness, sid) and sid not in harness._live


def test_a_run_with_no_log_starts_fresh_without_a_note(make_harness, fake_llm, workspace):
    first = make_harness()
    sid = start(first, workspace)
    first.close_all()
    run_id = first.store.get_session(sid).run_ids[-1]
    (first.office.paths.run_dir(sid) / "runs" / f"{run_id}.jsonl").unlink()  # its worker never started
    first.store.update_session(sid, status="busy")  # so restore resumes it now

    second = make_harness()
    jobs = spawned(second, lambda job: job.kind)
    second.restore()
    wait_for(lambda: sid in second._live and second._live[sid].turn_q, what="the fresh turn")
    session = second.store.get_session(sid)
    assert jobs == ["chat"] and len(session.run_ids) == 2 and session.model_note is None


def test_a_fresh_run_that_cant_be_recorded_leaves_the_old_runs_questions_open(make_harness, fake_llm, workspace,
                                                                             monkeypatch):
    harness = make_harness(llm_config={**LLM_CONFIG, "api_key": KEY})
    sid = start(harness, workspace)
    old = harness.store.get_session(sid).run_ids
    rewrite_office(harness, api_key="sk-another-key")

    def unrecorded(*args):
        raise OSError("disk full")

    monkeypatch.setattr(harness.store, "add_session_run", unrecorded)
    harness.prompt(sid, "a")  # the key changed, so a fresh run would take it
    wait_for(lambda: status(harness, sid) == "failed", what="the failed session")
    # Nothing was staled before the recording failed (in an office, Cards.ended expires them with the session).
    assert [q.status for q in harness.store.list_questions(run_id=old[-1])] == ["open"]

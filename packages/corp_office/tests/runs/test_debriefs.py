"""Each debrief attempt is a row under its session's last run, driven by the office, ended with the debrief."""

import threading

from opencorp.extensions import learning as learning_mod
from tests.chat.conftest import status, wait_for
from tests.profile.conftest import DEBRIEF_ASK, chat, debrief_reply, fails_once, settled


def rows(harness, sid):
    return harness.store.runs_of_session(sid)


def test_a_debrief_is_a_row_under_the_sessions_last_run_driven_by_the_office(harness, fake_llm, workspace, learning):
    fake_llm.script(debrief_reply())
    sid = chat(harness, fake_llm, workspace)
    wait_for(lambda: status(harness, sid) == "ended", what="the debrief")
    chat_row, debrief = rows(harness, sid)
    assert (debrief.flow, debrief.flow_path, debrief.driver, debrief.parent_run_id, debrief.outcome) == (
        "debrief", "shared/flows/debrief.yaml", "office", chat_row.run_id, "finished")
    assert debrief.run_id == harness.store.get_debrief_record(sid).run_id


def test_a_debrief_with_a_bad_output_fails_its_row(harness, fake_llm, workspace, learning, monkeypatch):
    monkeypatch.setattr(learning_mod, "ready_debrief", lambda session, output: (_ for _ in ()).throw(KeyError("x")))
    fake_llm.script(debrief_reply())
    sid = chat(harness, fake_llm, workspace)
    wait_for(lambda: status(harness, sid) == "ended", what="the debrief")
    assert (rows(harness, sid)[-1].outcome, rows(harness, sid)[-1].reason) == ("failed", "bad output")


def test_a_debrief_that_cant_start_fails_its_row_with_couldnt_start(harness, fake_llm, workspace, learning,
                                                                     monkeypatch):
    fails_once(monkeypatch, learning, "_debrief_job")
    sid = chat(harness, fake_llm, workspace)
    wait_for(lambda: len(rows(harness, sid)) == 2 and rows(harness, sid)[1].outcome, what="the failed attempt")
    assert (rows(harness, sid)[1].outcome, rows(harness, sid)[1].reason) == ("failed", "couldn't start")


def test_a_failed_debrief_and_its_retry_are_two_rows_under_the_same_run(harness, fake_llm, workspace, learning):
    fake_llm.script({"match": DEBRIEF_ASK, "error": 500})
    sid = chat(harness, fake_llm, workspace)
    wait_for(lambda: status(harness, sid) == "ended", what="the failed debrief")
    fake_llm.script(debrief_reply())
    learning.tick()
    wait_for(lambda: harness.store.get_debrief(sid).state == "ready", what="the retried debrief")
    chat_row, failed, retried = rows(harness, sid)
    assert (failed.outcome, retried.outcome) == ("failed", "finished")
    assert failed.reason and failed.ended_at  # the worker's failure
    assert failed.parent_run_id == retried.parent_run_id == chat_row.run_id
    assert retried.run_id == harness.store.get_debrief_record(sid).run_id


def test_a_debriefs_outcome_commits_with_the_debrief_and_the_sessions_end(harness, fake_llm, workspace, learning,
                                                                         monkeypatch):
    fake_llm.script(debrief_reply())
    end_run, tried = harness.store.end_run, threading.Event()

    def written_then_fails(run_id, outcome, **kw):
        written = end_run(run_id, outcome, **kw)
        if harness.store.get_run(run_id).flow != "debrief":
            return written
        tried.set()
        raise RuntimeError("disk full")

    monkeypatch.setattr(harness.store, "end_run", written_then_fails)
    sid = chat(harness, fake_llm, workspace)
    assert tried.wait(10)
    settled(learning)
    assert (status(harness, sid), rows(harness, sid)[-1].outcome, harness.store.get_debrief(sid).state) == (
        "debriefing", None, "pending")
    assert not learning._finished(sid, rows(harness, sid)[-1].run_id)  # no feedback on a debrief that wasn't stored

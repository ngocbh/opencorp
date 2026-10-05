import subprocess
import threading

import pytest

from agent_corp.chat.connections import ConnectionFile, read_run_record
from agent_corp.chat.harness import HarnessError
from agent_corp.extensions import learning as learning_module
from agent_corp.profile.debrief import DEBRIEF_FLOW
from agent_corp.profile.feedback import MAX_ATTEMPTS, FeedbackHandlers
from agent_corp.protocol import now
from agent_corp.protocol.models import Feedback, FeedbackRequest
from agent_corp.store import new_id
from tests.chat.conftest import on, say, spawned
from tests.profile.conftest import (LEARNER_ASK, asked, chat, debrief_reply, fails_once, learner_reply, review_reply,
                                    settled, status, wait_for)
from tests.store.conftest import session

PROFILE = "# Minh, Engineer\n"


def feedback_status(harness, fid):
    return harness.store.get_feedback(fid).status


def git_log(harness, *args):
    out = subprocess.run(["git", "-C", str(harness.git.root), "log", *args], capture_output=True, text=True)
    return out.stdout


def profile_text(harness):
    return (harness.git.root / "people/minh/profile.md").read_text()


def other(harness):
    """Commit a change that isn't the profile's, so HEAD moves on."""
    (harness.git.root / "notes.md").write_text("notes\n")
    for args in (["add", "notes.md"], ["commit", "-q", "-m", "notes"]):
        subprocess.run(["git", "-C", str(harness.git.root), "-c", "user.name=t", "-c", "user.email=t@t", *args],
                       check=True, capture_output=True)


def ended(harness, fake_llm, workspace):
    """A main session that ended and has its debrief."""
    fake_llm.script(debrief_reply())
    sid = chat(harness, fake_llm, workspace)
    wait_for(lambda: status(harness, sid) == "ended", what="the end of the debrief")
    return sid


def test_feedback_on_a_finished_run_is_learned_and_the_next_session_sees_it(harness, fake_llm, workspace, learning):
    sid = ended(harness, fake_llm, workspace)
    session = harness.store.get_session(sid)
    fake_llm.script(learner_reply(PROFILE + "\n- Be brief.\n", hold=True))
    fb = learning.add_feedback(FeedbackRequest(session_id=sid, text="Be brief."))
    assert (fb.run_id, fb.author, fb.status) == (session.run_ids[-1], "ngocbh", "queued")
    wait_for(lambda: any(LEARNER_ASK in asked(r) for r in fake_llm.requests()), what="the learner call")
    hold = threading.Event()
    learning._post(hold.wait, 10)  # Learning takes the attempt's outcome only once HEAD has moved on
    fake_llm.release()
    subject = f"profile(@minh): from feedback on run {fb.run_id} (ngocbh)"
    wait_for(lambda: git_log(harness, "-1", "--format=%s").strip() == subject, what="the learner's commit")
    learned = git_log(harness, "-1", "--format=%H").strip()
    other(harness)
    hold.set()
    wait_for(lambda: feedback_status(harness, fb.id) == "applied", what="applied")
    applied = harness.store.get_feedback(fb.id)
    assert (applied.attempts, applied.commit) == (1, learned)  # the learner's commit, not HEAD
    assert profile_text(harness) == PROFILE + "\n- Be brief.\n"
    learner = next(r for r in fake_llm.requests() if LEARNER_ASK in asked(r))
    assert "Be brief." in asked(learner)
    # The session's pinned worktree still has the profile its runs saw.
    assert (harness.git.pin(session.repo_commit) / "people/minh/profile.md").read_text() == PROFILE

    fake_llm.script({"content": "hi"})
    n = len(fake_llm.requests())
    nxt = harness.start_session("minh", str(workspace))
    wait_for(lambda: status(harness, nxt.id) == "idle", what="the first turn")
    harness.prompt(nxt.id, "hello")
    first = fake_llm.wait_for_requests(n + 1)[n]
    assert "- Be brief." in asked(first)


def test_feedback_and_follow_ups_are_credited_to_who_gave_them(harness, fake_llm, workspace, learning):
    sid = ended(harness, fake_llm, workspace)
    debrief = learning.confirm(sid, [0], by="lan")
    assert harness.store.get_work_item(debrief.follow_ups[0].work_item_id).requester == "lan"
    fake_llm.script(learner_reply(PROFILE + "\n- Be brief.\n"))
    fb = learning.add_feedback(FeedbackRequest(session_id=sid, text="Be brief."), by="lan")
    assert fb.author == "lan"
    wait_for(lambda: feedback_status(harness, fb.id) == "applied", what="applied")
    assert f"from feedback on run {fb.run_id} (lan)" in git_log(harness, "--format=%s")


def test_a_second_feedback_on_the_same_run_learns_again(harness, fake_llm, workspace, learning):
    sid = ended(harness, fake_llm, workspace)
    fake_llm.script(learner_reply(PROFILE + "\n- Be brief.\n"))
    first = learning.add_feedback(FeedbackRequest(session_id=sid, text="Be brief."))
    wait_for(lambda: feedback_status(harness, first.id) == "applied", what="the first")
    fake_llm.script(learner_reply(PROFILE + "\n- Be brief.\n- Cite files.\n"))
    second = learning.add_feedback(FeedbackRequest(session_id=sid, run_id=first.run_id, text="Cite files."))
    wait_for(lambda: feedback_status(harness, second.id) == "applied", what="the second")
    assert profile_text(harness) == PROFILE + "\n- Be brief.\n- Cite files.\n"
    learners = [r for r in fake_llm.requests() if LEARNER_ASK in asked(r)]
    assert len(learners) == 2 and "- Be brief." in asked(learners[1])  # it read the current text


def test_feedback_waits_while_a_worker_of_the_session_is_live(harness, fake_llm, workspace, learning):
    fake_llm.script(debrief_reply(hold=True))
    sid = chat(harness, fake_llm, workspace)
    wait_for(lambda: status(harness, sid) == "debriefing", what="debriefing")
    fake_llm.wait_for_requests(2)  # the debrief's model call, held
    fake_llm.script(learner_reply(PROFILE + "\n- Be brief.\n"))
    fb = learning.add_feedback(FeedbackRequest(session_id=sid, text="Be brief."))
    settled(learning)
    assert feedback_status(harness, fb.id) == "queued"
    assert not any(LEARNER_ASK in asked(r) for r in fake_llm.requests())
    fake_llm.release()
    wait_for(lambda: feedback_status(harness, fb.id) == "applied", what="applied after the debrief")
    assert status(harness, sid) == "ended"


def test_feedback_on_the_debrief_run_learns_through_the_debrief_flow(harness, fake_llm, workspace, learning):
    sid = ended(harness, fake_llm, workspace)
    record = harness.store.get_debrief_record(sid)
    fake_llm.script(review_reply(), learner_reply(PROFILE + "\n- Shorter debriefs.\n"))
    fb = learning.add_feedback(FeedbackRequest(session_id=sid, run_id=record.run_id, text="Shorter debriefs."))
    wait_for(lambda: feedback_status(harness, fb.id) == "applied", what="applied")
    assert profile_text(harness).endswith("- Shorter debriefs.\n")


def test_feedback_needs_a_finished_run_of_the_session(harness, fake_llm, workspace, learning):
    fake_llm.script({"content": "hi"})
    live = harness.start_session("minh", str(workspace))
    wait_for(lambda: status(harness, live.id) == "idle", what="the first turn")
    with pytest.raises(HarnessError) as err:
        learning.add_feedback(FeedbackRequest(session_id=live.id, text="x"))
    assert (err.value.status, err.value.code) == (409, "run_unfinished")
    with pytest.raises(HarnessError) as err:
        learning.add_feedback(FeedbackRequest(session_id=live.id, run_id="nope", text="x"))
    assert (err.value.status, err.value.code) == (422, "invalid_body")
    with pytest.raises(HarnessError) as err:
        learning.add_feedback(FeedbackRequest(session_id="01J00000000000000000000000", text="x"))
    assert err.value.status == 404
    side = harness.store.create_session(session(repo_commit=harness.git.head(), kind="side", status="ended",
                                                run_ids=["r1"]))
    with pytest.raises(HarnessError) as err:
        learning.add_feedback(FeedbackRequest(session_id=side.id, run_id="r1", text="x"))
    assert (err.value.status, err.value.code) == (422, "not_learnable")
    assert harness.store.list_feedback() == []


def test_feedback_whose_attempt_committed_and_then_failed_is_not_retried(harness, fake_llm, workspace, learning,
                                                                          monkeypatch):
    def failed_after_committing(self, worker, frame):
        self.outcome = {**frame, "backward": {"status": "failed",
                                              "failure": {"code": "provider_error", "message": "after the write"}}}

    monkeypatch.setattr(FeedbackHandlers, "result", failed_after_committing)
    sid = ended(harness, fake_llm, workspace)
    fake_llm.script(learner_reply(PROFILE + "\n- Be brief.\n"))
    fb = learning.add_feedback(FeedbackRequest(session_id=sid, text="Be brief."))
    wait_for(lambda: feedback_status(harness, fb.id) == "learning_failed", what="learning_failed")
    assert git_log(harness, "-1", "--format=%s").strip() == (
        f"profile(@minh): from feedback on run {fb.run_id} (ngocbh)")  # the write stands
    learning.tick()
    settled(learning)
    failed = harness.store.get_feedback(fb.id)
    assert (failed.status, failed.attempts) == ("learning_failed", 1)
    assert sum(LEARNER_ASK in asked(r) for r in fake_llm.requests()) == 1


def test_feedback_whose_move_into_learning_fails_stays_queued_and_learns_later(harness, fake_llm, workspace, learning,
                                                                               monkeypatch):
    sid = ended(harness, fake_llm, workspace)
    fails_once(monkeypatch, harness.store, "set_feedback_status")
    fb = learning.add_feedback(FeedbackRequest(session_id=sid, text="Be brief."))
    settled(learning)
    assert sid not in learning._active and feedback_status(harness, fb.id) == "queued"
    fake_llm.script(learner_reply(PROFILE + "\n- Be brief.\n"))
    learning.tick()
    wait_for(lambda: feedback_status(harness, fb.id) == "applied", what="applied")


def ended_on_second(harness, fake_llm, workspace):
    """A main session whose last run and debrief ran on connection ``second``; it has ended."""
    fake_llm.script({"content": "Done."}, debrief_reply())
    sid = harness.start_session("minh", str(workspace)).id
    wait_for(lambda: status(harness, sid) == "idle", what="the first turn")
    on(harness, sid, "second")
    say(harness, sid, "fix the bug")  # a fresh run on second takes it
    harness.end(sid)
    wait_for(lambda: status(harness, sid) == "ended", what="the end of the debrief")
    return sid


def change_second(harness, **llm):
    """Change connection ``second``'s llm_config."""
    conn = harness.connections.get("second")
    harness.connections.put("second", ConnectionFile(llm_config={**conn.llm_config, **llm}, env=conn.env))


def test_backward_uses_the_runs_own_connection(harness, fake_llm, workspace, learning):
    sid = ended_on_second(harness, fake_llm, workspace)
    on(harness, sid, None)  # the chat is on office now; its last run wasn't
    jobs = spawned(harness)
    fake_llm.script(learner_reply(PROFILE + "\n- Be brief.\n"))
    fb = learning.add_feedback(FeedbackRequest(session_id=sid, text="Be brief."))
    wait_for(lambda: feedback_status(harness, fb.id) == "applied", what="applied")
    second = harness.connections.resolve("second", None)
    (job,) = jobs
    assert (job.kind, job.run_id, job.llm_config, job.env) == ("backward", fb.run_id, second.llm_config, second.env)
    assert job.memory["profile"].llm_config == second.llm_config


def test_backward_on_a_removed_connection_fails_at_once_with_a_reason(harness, fake_llm, workspace, learning):
    sid = ended_on_second(harness, fake_llm, workspace)
    harness.connections.remove("second")
    jobs = spawned(harness)
    fb = learning.add_feedback(FeedbackRequest(session_id=sid, text="Be brief."))
    settled(learning)
    failed = harness.store.get_feedback(fb.id)
    assert (failed.status, failed.attempts, failed.failure) == ("learning_failed", 0, "connection 'second' was removed")
    assert jobs == [] and sid not in learning._active


def test_backward_after_a_key_change_fails_instead_of_using_the_new_key(harness, fake_llm, workspace, learning):
    sid = ended_on_second(harness, fake_llm, workspace)
    change_second(harness, api_key="sk-a-new-key")
    jobs = spawned(harness)
    fb = learning.add_feedback(FeedbackRequest(session_id=sid, text="Be brief."))
    settled(learning)
    failed = harness.store.get_feedback(fb.id)
    assert (failed.status, failed.attempts) == ("learning_failed", 0)
    assert failed.failure == f"connection 'second' changed (endpoint or key) since run {fb.run_id}"
    assert jobs == []


def test_backward_after_a_model_only_change_still_runs(harness, fake_llm, workspace, learning):
    sid = ended_on_second(harness, fake_llm, workspace)
    change_second(harness, model="stub-3")
    jobs = spawned(harness)
    fake_llm.script(learner_reply(PROFILE + "\n- Be brief.\n"))
    fb = learning.add_feedback(FeedbackRequest(session_id=sid, text="Be brief."))
    wait_for(lambda: feedback_status(harness, fb.id) == "applied", what="applied")
    assert [(j.kind, j.llm_config["model"]) for j in jobs] == [("backward", "stub-3")]


def test_backward_on_the_debrief_uses_the_debriefs_record(harness, fake_llm, workspace, learning):
    sid = ended_on_second(harness, fake_llm, workspace)
    record = harness.store.get_debrief_record(sid)
    runs = harness.office.paths.run_dir(sid) / "runs"
    assert read_run_record(runs / f"{record.run_id}.model.json").connection == "second"
    on(harness, sid, None)
    jobs = spawned(harness)
    fake_llm.script(review_reply(), learner_reply(PROFILE + "\n- Shorter debriefs.\n"))
    fb = learning.add_feedback(FeedbackRequest(session_id=sid, run_id=record.run_id, text="Shorter debriefs."))
    wait_for(lambda: feedback_status(harness, fb.id) == "applied", what="applied")
    assert [(j.kind, j.flow, j.llm_config["model"]) for j in jobs] == [("backward", DEBRIEF_FLOW, "stub-2")]


def test_a_debrief_on_a_removed_connection_runs_on_the_default(harness, fake_llm, workspace, learning):
    fake_llm.script({"content": "Done."}, debrief_reply())
    sid = harness.start_session("minh", str(workspace)).id
    wait_for(lambda: status(harness, sid) == "idle", what="the first turn")
    say(harness, sid, "fix the bug")
    on(harness, sid, "second")
    harness.connections.remove("second")
    jobs = spawned(harness)
    harness.end(sid)
    wait_for(lambda: status(harness, sid) == "ended", what="the end of the debrief")
    assert [(j.flow, j.llm_config["model"]) for j in jobs] == [(DEBRIEF_FLOW, "stub")]
    run_id = harness.store.get_debrief_record(sid).run_id
    record = read_run_record(harness.office.paths.run_dir(sid) / "runs" / f"{run_id}.model.json")
    assert (record.connection, record.model) == ("office", None)
    assert harness.store.get_session(sid).connection == "second"  # a debrief doesn't move the chat


def test_the_debrief_records_its_run_before_it_spawns(harness, fake_llm, workspace, learning, monkeypatch):
    def unwritable(*args):
        raise OSError("disk full")

    monkeypatch.setattr(learning_module, "write_run_record", unwritable)
    jobs = spawned(harness)
    sid = chat(harness, fake_llm, workspace)
    wait_for(lambda: status(harness, sid) == "ended", what="the end")
    record = harness.store.get_debrief_record(sid)
    assert (record.debrief.state, record.attempts) == ("pending", 1)
    assert [j.flow for j in jobs if j.flow == DEBRIEF_FLOW] == []


def test_backward_retries_later_when_the_connections_cant_be_read_now(harness, fake_llm, workspace, learning):
    sid = ended(harness, fake_llm, workspace)
    provider_json = harness.office.paths.office / "provider.json"
    provider_json.chmod(0o644)  # refused until it's private again
    jobs = spawned(harness)
    fb = learning.add_feedback(FeedbackRequest(session_id=sid, text="Be brief."))
    settled(learning)
    waiting = harness.store.get_feedback(fb.id)
    assert (waiting.status, waiting.attempts, waiting.failure, jobs) == ("queued", 1, None, [])
    provider_json.chmod(0o600)
    fake_llm.script(learner_reply(PROFILE + "\n- Be brief.\n"))
    learning.tick()
    wait_for(lambda: feedback_status(harness, fb.id) == "applied", what="applied")
    assert [j.kind for j in jobs] == ["backward"]


def test_backward_that_cant_use_its_connection_for_good_fails_with_a_fixed_reason(harness, fake_llm, workspace,
                                                                                    learning):
    sid = ended(harness, fake_llm, workspace)
    (harness.office.paths.office / "provider.json").chmod(0o644)
    fb = learning.add_feedback(FeedbackRequest(session_id=sid, text="Be brief."))
    settled(learning)
    for _ in range(MAX_ATTEMPTS):
        learning.tick()
        settled(learning)
    failed = harness.store.get_feedback(fb.id)
    assert (failed.status, failed.attempts) == ("learning_failed", MAX_ATTEMPTS)
    assert failed.failure == "connection 'office' couldn't be used"  # never a path


@pytest.mark.parametrize("why", ["removed", "unusable"])
def test_a_feedback_move_that_fails_doesnt_stop_the_ticks_other_feedback(harness, fake_llm, workspace, learning,
                                                                         monkeypatch, why):
    stuck = ended_on_second(harness, fake_llm, workspace)
    fine = ended(harness, fake_llm, workspace)
    if why == "removed":
        harness.connections.remove("second")
    else:
        (harness.connections.dir / "second.json").chmod(0o644)
    feedback = [harness.store.add_feedback(Feedback(
        id=new_id(), session_id=sid, run_id=harness.store.get_session(sid).run_ids[-1], author="ngocbh",
        text="Be brief.", status="queued", created_at=now())) for sid in (stuck, fine)]
    set_status = harness.store.set_feedback_status

    def flaky(feedback_id, status, **kwargs):
        if feedback_id == feedback[0].id:
            raise RuntimeError("the store is busy")
        return set_status(feedback_id, status, **kwargs)

    monkeypatch.setattr(harness.store, "set_feedback_status", flaky)
    fake_llm.script(learner_reply(PROFILE + "\n- Be brief.\n"))
    learning.tick()  # the stuck one comes first
    wait_for(lambda: feedback_status(harness, feedback[1].id) == "applied", what="the other feedback applied")
    assert feedback_status(harness, feedback[0].id) == "queued"

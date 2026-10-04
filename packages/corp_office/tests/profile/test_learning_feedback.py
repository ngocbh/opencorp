import subprocess
import threading

import pytest

from agent_corp.chat.harness import HarnessError
from agent_corp.profile.feedback import FeedbackHandlers
from agent_corp.protocol.models import FeedbackRequest
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

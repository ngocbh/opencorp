from agent_corp.profile.feedback import MAX_ATTEMPTS
from agent_corp.protocol.models import FeedbackRequest
from tests.profile.conftest import LEARNER_ASK, asked, learner_reply, wait_for
from tests.profile.test_learning_feedback import PROFILE, ended, feedback_status, profile_text

HAND = PROFILE + "\n- Hand edit.\n"


def learners(fake_llm):
    return [r for r in fake_llm.requests() if LEARNER_ASK in asked(r)]


def test_a_hand_edit_during_learning_is_kept_and_the_feedback_is_learned_again(harness, fake_llm, workspace,
                                                                                learning):
    sid = ended(harness, fake_llm, workspace)
    fake_llm.script(learner_reply(PROFILE + "\n- Be brief.\n", hold=True),
                    learner_reply(HAND + "- Be brief.\n"))
    fb = learning.add_feedback(FeedbackRequest(session_id=sid, text="Be brief."))
    wait_for(lambda: len(learners(fake_llm)) == 1, what="the learner call")
    (harness.git.root / "people/minh/profile.md").write_text(HAND)  # the owner edits while the learner thinks
    fake_llm.release()
    wait_for(lambda: feedback_status(harness, fb.id) == "applied", what="applied")
    assert harness.store.get_feedback(fb.id).attempts == 2
    assert profile_text(harness) == HAND + "- Be brief.\n"
    assert "- Hand edit." in asked(learners(fake_llm)[1])  # the retry read the hand edit


def test_feedback_that_keeps_meeting_hand_edits_fails_after_three_attempts(harness, fake_llm, workspace, learning):
    sid = ended(harness, fake_llm, workspace)
    fake_llm.script(*[learner_reply(PROFILE + "\n- Be brief.\n", hold=True) for _ in range(MAX_ATTEMPTS)])
    fb = learning.add_feedback(FeedbackRequest(session_id=sid, text="Be brief."))
    for n in range(1, MAX_ATTEMPTS + 1):
        wait_for(lambda: len(learners(fake_llm)) == n, what=f"learner call {n}")
        (harness.git.root / "people/minh/profile.md").write_text(PROFILE + f"\n- Hand edit {n}.\n")
        fake_llm.release()
    wait_for(lambda: feedback_status(harness, fb.id) == "learning_failed", what="learning_failed")
    assert harness.store.get_feedback(fb.id).attempts == MAX_ATTEMPTS
    assert profile_text(harness) == PROFILE + f"\n- Hand edit {MAX_ATTEMPTS}.\n"

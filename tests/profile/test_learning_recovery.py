from agent_corp.extensions.learning import Learning
from agent_corp.profile.debrief import ready_debrief
from agent_corp.protocol import now
from agent_corp.protocol.models import Feedback
from agent_corp.store import new_id
from tests.profile.conftest import OUTPUT, chat, debrief_reply, learner_reply, settled, status, wait_for
from tests.profile.test_learning_feedback import PROFILE, feedback_status, profile_text
from tests.store.conftest import session


def test_a_new_office_finishes_the_debriefs_and_feedback_the_last_one_left(harness, fake_llm, workspace):
    first = Learning(harness.office, harness, tick=None)
    first.start()
    fake_llm.script(debrief_reply(hold=True))
    sid = chat(harness, fake_llm, workspace)
    wait_for(lambda: status(harness, sid) == "debriefing", what="debriefing")
    fake_llm.wait_for_requests(2)
    first.stop()  # the office stops mid-debrief
    wait_for(lambda: harness.registry.get(sid) is None, what="the debrief worker to stop")
    run_id = harness.store.get_session(sid).run_ids[-1]
    fb = harness.store.add_feedback(Feedback(id=new_id(), session_id=sid, run_id=run_id, author="ngocbh",
                                             text="Be brief.", status="queued", created_at=now()))
    harness.store.set_feedback_status(fb.id, "learning")  # its worker died with the office
    assert (status(harness, sid), harness.store.get_debrief(sid).state) == ("debriefing", "pending")

    fake_llm.script(debrief_reply(), learner_reply(PROFILE + "\n- Be brief.\n"))
    second = Learning(harness.office, harness, tick=None)
    second.start()
    try:
        wait_for(lambda: feedback_status(harness, fb.id) == "applied", what="the feedback")
        assert status(harness, sid) == "ended"
        record = harness.store.get_debrief_record(sid)
        assert (record.debrief.state, record.attempts) == ("ready", 1)
        assert profile_text(harness) == PROFILE + "\n- Be brief.\n"
    finally:
        second.stop()


def test_a_session_left_debriefing_with_a_ready_debrief_just_ends(harness, fake_llm):
    s = harness.store.create_session(session(repo_commit=harness.git.head(), status="debriefing", run_ids=["r1"]))
    harness.store.save_debrief(ready_debrief(s, OUTPUT), run_id="dbr", attempts=1)
    learning = Learning(harness.office, harness, tick=None)
    learning.start()
    try:
        wait_for(lambda: status(harness, s.id) == "ended", what="ended")
        settled(learning)
    finally:
        learning.stop()
    record = harness.store.get_debrief_record(s.id)
    assert (record.debrief.state, record.run_id, record.attempts) == ("ready", "dbr", 1)
    assert fake_llm.requests() == []  # no second debrief ran

"""Continuing an ended Codex session: a new row on the same thread, resumed."""

import pytest

from agent_corp.chat.harness import HarnessError
from agent_corp.extensions.learning import Learning
from agent_corp.testing import fake_codex as fc
from tests.harness.conftest import errors, start, status, texts, wait_for
from tests.profile.conftest import LEARNING_FILES, debrief_reply


def ended(harness, workspace, prompt="one", by="ngocbh"):
    """A Codex session of minh's that ran one turn and ended."""
    sid = start(harness, workspace, by=by)
    harness.prompt(sid, prompt)
    wait_for(lambda: status(harness, sid) == "idle" and harness.store.list_messages(sid)[-1].role == "assistant",
             what="the first stretch")
    harness.end(sid)
    wait_for(lambda: status(harness, sid) in ("ended", "debriefing"), what="ended")
    return sid


def test_continuing_makes_a_new_row_on_the_same_thread_and_resumes_it(harness, fake_codex, workspace):
    fake_codex.script([[*fc.agent_message("m1", "First"), fc.token_usage(1200, 800, 90)],
                       [*fc.agent_message("m2", "Second"), fc.token_usage(2000, 1000, 150)]])
    old = ended(harness, workspace)
    before = harness.store.get_session(old)
    new = harness.continue_session(old, by="ava")
    assert (new.parent_session_id, new.harness_session_id, new.harness, new.person, new.cwd, new.opened_by) == (
        old, "thr_1", "codex", "minh", before.cwd, "ava")
    assert new.work_item_id != before.work_item_id
    assert harness.store.get_work_item(new.work_item_id).requester == "ava"
    wait_for(lambda: status(harness, new.id) == "idle", what="the resume")
    assert [c["threadId"] for c in fake_codex.calls("thread/resume")] == ["thr_1"]
    assert len(fake_codex.calls("thread/start")) == 1  # only the first stretch started a thread
    harness.prompt(new.id, "two")
    wait_for(lambda: texts(harness, new.id) == ["Second"] and status(harness, new.id) == "idle",
             what="the second stretch")
    wait_for(lambda: harness.store.get_session(new.id).harness_usage is not None, what="usage")
    assert texts(harness, old) == ["First"]
    # Codex counts the whole thread; each stretch keeps only its own tokens.
    assert harness.store.get_session(new.id).harness_usage.model_dump() == {
        "input_tokens": 800, "cached_input_tokens": 200, "output_tokens": 60}
    assert harness.store.get_session(old) == before


@pytest.mark.parametrize("case", ["live", "composer", "missing", "continued"])
def test_only_an_ended_codex_session_with_no_live_continuation_continues(harness, workspace, case):
    sid = start(harness, workspace) if case != "missing" else "01J0000000000000000000000X"
    if case == "composer":
        harness.store.update_session(sid, harness="composer", status="ended")
    if case == "continued":
        harness.end(sid)
        wait_for(lambda: status(harness, sid) == "ended", what="ended")
        live = harness.continue_session(sid, by="ngocbh")
        wait_for(lambda: status(harness, live.id) == "idle", what="the resume")
    with pytest.raises(HarnessError) as e:
        harness.continue_session(sid, by="ngocbh")
    assert e.value.status == {"live": 409, "composer": 422, "missing": 404, "continued": 409}[case]


def test_continuing_an_older_stretch_counts_only_its_own_tokens(harness, fake_codex, workspace):
    fake_codex.script([[*fc.agent_message("m1", "A"), fc.token_usage(1000, 0, 10)],
                       [*fc.agent_message("m2", "B"), fc.token_usage(3000, 0, 30)],
                       [*fc.agent_message("m3", "C"), fc.token_usage(3500, 0, 35)]])
    a = ended(harness, workspace)
    for prompt in ("b", "c"):  # both continue a, the first stretch; the second comes after b on the thread
        s = harness.continue_session(a, by="ngocbh")
        wait_for(lambda: status(harness, s.id) == "idle", what="the resume")
        harness.prompt(s.id, prompt)
        wait_for(lambda: harness.store.get_session(s.id).harness_usage is not None and status(harness, s.id) == "idle",
                 what="the stretch")
        harness.end(s.id)
        wait_for(lambda: status(harness, s.id) == "ended", what="ended")
        if prompt == "b":
            b = s.id
    assert harness.store.get_session(s.id).parent_session_id == b  # the thread's chain stays one line
    assert harness.store.get_session(s.id).harness_usage.model_dump() == {
        "input_tokens": 500, "cached_input_tokens": 0, "output_tokens": 5}


def test_a_resume_codex_refuses_fails_the_new_row_and_leaves_the_old_one(harness, fake_codex, workspace):
    fake_codex.script([fc.agent_message("m1", "First")])
    old = ended(harness, workspace)
    before = harness.store.get_session(old)
    fake_codex.script(resume_error={"code": -32600, "message": "no rollout found for thread thr_1"})
    new = harness.continue_session(old, by="ngocbh")
    wait_for(lambda: status(harness, new.id) == "failed", what="the failed resume")
    assert errors(harness, new.id) == ["Codex refused to load the thread: no rollout found for thread thr_1"]
    assert harness.store.get_session(old) == before


def test_a_session_ended_before_an_office_restart_continues_after_it(make_codex, fake_codex, workspace):
    fake_codex.script([fc.agent_message("m1", "First"), fc.agent_message("m2", "Second")])
    old_office = make_codex()
    old = ended(old_office, workspace)
    old_office.close_all()
    h = make_codex()
    h.restore()
    new = h.continue_session(old, by="ngocbh")
    wait_for(lambda: status(h, new.id) == "idle", what="the resume")
    assert fake_codex.calls("thread/resume")[0]["threadId"] == "thr_1"
    h.prompt(new.id, "two")
    wait_for(lambda: texts(h, new.id) == ["Second"], what="the second stretch")


def test_each_stretch_gets_its_own_debrief(make_codex, fake_codex, fake_llm, workspace):
    h = make_codex(files=LEARNING_FILES)
    learning = Learning(h.office, h, tick=None)
    learning.start()
    try:
        fake_codex.script([fc.agent_message("m1", "First"), fc.agent_message("m2", "Second")])
        fake_llm.script(debrief_reply(), debrief_reply())
        old = ended(h, workspace, prompt="make a")
        wait_for(lambda: status(h, old) == "ended", what="the first debrief")
        new = h.continue_session(old, by="ngocbh")
        wait_for(lambda: status(h, new.id) == "idle", what="the resume")
        h.prompt(new.id, "make b")
        wait_for(lambda: texts(h, new.id) == ["Second"] and status(h, new.id) == "idle", what="the second stretch")
        h.end(new.id)
        wait_for(lambda: status(h, new.id) == "ended", what="the second debrief")
        assert h.store.get_debrief(old).state == h.store.get_debrief(new.id).state == "ready"
        sent = str(fake_llm.requests()[-1])
        assert "@ngocbh: make b" in sent and "make a" not in sent
    finally:
        learning.stop()

import asyncio
from types import SimpleNamespace

import pytest

from agent_corp.chat.harness import HarnessError
from agent_corp.extensions.learning import Learning, register
from agent_corp.store import new_id
from tests.profile.conftest import DEBRIEF_ASK, OUTPUT, asked, chat, debrief_reply, settled, status, wait_for
from tests.store.conftest import message, session


def attempts(harness, sid):
    record = harness.store.get_debrief_record(sid)
    return record.attempts if record else 0


def debrief_state(harness, sid):
    debrief = harness.store.get_debrief(sid)
    return debrief.state if debrief else None


def test_ending_a_session_debriefs_it_from_its_transcript(harness, fake_llm, workspace, learning):
    fake_llm.script(debrief_reply(hold=True))
    sid = chat(harness, fake_llm, workspace)
    wait_for(lambda: status(harness, sid) == "debriefing", what="debriefing")
    request = next(r for r in fake_llm.wait_for_requests(2) if DEBRIEF_ASK in asked(r))
    assert "user: fix the bug" in asked(request) and "assistant: Done." in asked(request)
    fake_llm.release()
    wait_for(lambda: status(harness, sid) == "ended", what="the end of the debrief")
    record = harness.store.get_debrief_record(sid)
    assert record.debrief.state == "ready" and record.attempts == 1
    assert record.debrief.model_dump(include={"summary", "status", "artifacts", "decisions", "open_questions"}) == {
        k: OUTPUT[k] for k in ("summary", "status", "artifacts", "decisions", "open_questions")}
    assert [f.text for f in record.debrief.follow_ups] == OUTPUT["follow_ups"]
    assert record.run_id not in harness.store.get_session(sid).run_ids


def test_a_failed_debrief_is_pending_after_one_model_call_and_the_retry_makes_it_ready(
        harness, fake_llm, workspace, learning):
    fake_llm.script({"match": DEBRIEF_ASK, "error": 500})
    sid = chat(harness, fake_llm, workspace)
    wait_for(lambda: status(harness, sid) == "ended", what="the end")
    record = harness.store.get_debrief_record(sid)
    assert (record.debrief.state, record.attempts) == ("pending", 1)
    assert sum(DEBRIEF_ASK in asked(r) for r in fake_llm.requests()) == 1  # no retry inside the run

    fake_llm.script(debrief_reply())
    learning.tick()
    wait_for(lambda: debrief_state(harness, sid) == "ready", what="the retried debrief")
    assert harness.store.get_debrief_record(sid).attempts == 2


def test_the_tick_gives_up_after_three_debriefs_but_a_read_retries(harness, fake_llm, workspace, learning):
    fake_llm.script(*[{"match": DEBRIEF_ASK, "error": 500}] * 3)
    sid = chat(harness, fake_llm, workspace)
    for n in (1, 2, 3):
        wait_for(lambda: attempts(harness, sid) == n, what=f"debrief {n}")
        learning.tick()
    settled(learning)
    assert harness.registry.get(sid) is None  # the last tick started no fourth debrief
    fake_llm.script(debrief_reply())
    assert learning.debrief(sid).state == "pending"
    wait_for(lambda: debrief_state(harness, sid) == "ready", what="the debrief GET retried")


def test_a_main_session_that_failed_is_debriefed_but_not_one_that_never_ran_or_a_side_chat(harness, fake_llm, learning):
    head = harness.git.head()
    ran = harness.store.create_session(session(repo_commit=head, status="failed", run_ids=["r1"]))
    harness.store.add_message(message(ran.id, parts=[{"id": new_id(), "type": "text", "text": "fix it"}]))
    never = harness.store.create_session(session(repo_commit=head, status="failed"))
    side = harness.store.create_session(session(repo_commit=head, status="failed", kind="side", run_ids=["r2"]))
    fake_llm.script(debrief_reply())
    learning.tick()
    wait_for(lambda: debrief_state(harness, ran.id) == "ready", what="the debrief")
    settled(learning)
    assert harness.store.get_debrief(never.id) is None and harness.store.get_debrief(side.id) is None
    assert harness.store.get_session(ran.id).status == "failed"


def test_a_debrief_is_not_found_before_debriefing_and_pending_from_then_on(harness, learning):
    head = harness.git.head()
    live = harness.store.create_session(session(repo_commit=head, status="idle"))
    with pytest.raises(HarnessError) as err:
        learning.debrief(live.id)
    assert (err.value.status, err.value.code) == (404, "not_found")
    ending = harness.store.create_session(session(repo_commit=head, status="debriefing"))
    assert learning.debrief(ending.id).state == "pending"  # before its debrief run stores the record


def test_learning_registers_only_on_an_office_that_runs_the_harness(harness):
    bare = SimpleNamespace(extras={}, on_start=[], on_stop=[])
    register(bare)
    assert (bare.extras, bare.on_start) == ({}, [])
    office = office_with(harness)
    register(office)
    assert isinstance(office.extras["learning"], Learning)
    assert len(office.on_start) == len(office.on_stop) == 1
    assert office.workers is not harness  # stopping the workers stops learning first


def test_a_debrief_the_office_stop_kills_is_not_an_attempt(harness, fake_llm, workspace):
    office = office_with(harness)
    register(office)
    learning = office.extras["learning"]
    learning.start()
    fake_llm.script(debrief_reply(hold=True))
    sid = chat(harness, fake_llm, workspace)
    wait_for(lambda: any(DEBRIEF_ASK in asked(r) for r in fake_llm.requests()), what="the debrief request")
    office.workers.close_all()
    for callback in reversed(office.on_stop):
        asyncio.run(callback())
    fake_llm.release()
    assert harness.registry.get(sid) is None
    assert (status(harness, sid), debrief_state(harness, sid), attempts(harness, sid)) == ("debriefing", "pending", 0)


def office_with(harness):
    """An office running ``harness``, as ``build_office`` makes it."""
    return SimpleNamespace(**vars(harness.office), extras={"harness": harness}, workers=harness,
                           on_start=[], on_stop=[])

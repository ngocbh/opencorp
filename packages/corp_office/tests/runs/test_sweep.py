"""At office start, runs an earlier office left open are interrupted, except live sessions' current runs."""

from opencorp.protocol import now
from opencorp.store import RunRow, new_id
from tests.chat.conftest import status, wait_for
from tests.store.conftest import session as stored_session


def test_the_start_sweep_interrupts_what_an_earlier_office_left_open(make_harness, workspace):
    first = make_harness()
    sid = first.start_session("minh", str(workspace)).id
    wait_for(lambda: status(first, sid) == "idle", what="the first turn")
    first.close_all()
    current = first.store.get_session(sid).run_ids[-1]
    debriefing = first.store.create_session(stored_session(status="debriefing", repo_commit=first.git.head()))
    killed = first.store.add_run(RunRow(new_id(), debriefing.id, "debrief", "shared/flows/debrief.yaml", "office",
                                        None, now()))
    replaced = first.store.add_run(RunRow(new_id(), sid, "chat", "shared/flows/chat.yaml", "ngocbh", None, now()))

    second = make_harness()
    second.restore()
    got = second.store.get_runs([current, killed.run_id, replaced.run_id])
    assert (got[killed.run_id].outcome, got[killed.run_id].reason, got[killed.run_id].ended_at) == (
        "interrupted", "the office stopped", None)
    assert got[replaced.run_id].outcome == "interrupted"
    assert got[current].outcome is None  # the idle session sleeps; its run is still open


def test_the_start_sweep_leaves_a_resumed_sessions_current_run_to_restore(make_harness, workspace):
    first = make_harness()
    sid = first.start_session("minh", str(workspace)).id
    wait_for(lambda: status(first, sid) == "idle", what="the first turn")
    first.close_all()
    current = first.store.get_session(sid).run_ids[-1]
    first.store.update_session(sid, status="busy")  # mid-reply: restore resumes it under the same run

    second = make_harness()
    second.restore()
    wait_for(lambda: status(second, sid) == "idle", what="the resumed turn")
    assert second.store.get_session(sid).run_ids[-1] == current
    assert second.store.get_run(current).outcome is None

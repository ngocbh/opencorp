"""What memory says about runs: each harness run's open nodes, sent as run.updated, and each debrief in flight."""

import os
import signal

from opencorp.runs.outcomes import RunEnd
from tests.chat.conftest import status, wait_for
from tests.profile.conftest import chat, debrief_reply


def start(harness, workspace):
    session = harness.start_session("minh", str(workspace))
    wait_for(lambda: status(harness, session.id) == "idle", what="the first turn")
    return session.id


def updates(harness, run_id):
    return [e.data for e in harness.office.bus.metas if e.type == "run.updated" and e.data["run_id"] == run_id]


def test_a_runs_open_nodes_are_kept_from_its_frames_and_sent(harness, fake_llm, workspace):
    fake_llm.script({"content": "Hello.", "hold": 30})
    sid = start(harness, workspace)
    run_id = harness.store.get_session(sid).run_ids[-1]
    harness.prompt(sid, "hi")
    fake_llm.wait_for_requests(1)
    wait_for(lambda: any(n.endswith("/reply") for n in harness.open_nodes(run_id)), what="the reply's start")
    assert harness.live_runs() == ({sid: run_id}, frozenset())
    sent = wait_for(lambda: [u for u in updates(harness, run_id)
                             if any(n.endswith("/reply") for n in u["current_nodes"])], what="its run.updated")
    assert (sent[0]["status"], sent[0]["session_id"]) == ("running", sid)
    fake_llm.release()
    wait_for(lambda: status(harness, sid) == "idle", what="the next turn")
    wait_for(lambda: not any(n.endswith("/reply") for n in harness.open_nodes(run_id)), what="the reply's end")


def test_a_new_worker_starts_with_no_open_nodes(harness, workspace):
    sid = start(harness, workspace)
    live = harness._live[sid]
    live.open_nodes.apply("NodeStarted", {"node_id": "ghost"})
    old = live.worker
    os.killpg(old.pgid, signal.SIGKILL)
    wait_for(lambda: live.worker not in (None, old) and live.turn_q, what="the resumed worker")
    assert "ghost" not in harness.open_nodes(live.run_id)


def test_a_run_that_has_ended_sends_no_trailing_running(harness, workspace):
    sid = start(harness, workspace)
    live = harness._live[sid]
    harness._finish(live, "failed", None)
    assert harness._run_updated(live, live.run_id) is None


def test_close_all_stops_the_notifier(harness):
    harness.notifier.changed("r", lambda: None)
    harness.notifier.changed("r", lambda: None)  # coalesced: starts its thread
    harness.close_all()
    assert not harness.notifier._thread.is_alive()


def test_a_debrief_in_flight_is_known_with_its_open_nodes(harness, fake_llm, workspace, learning):
    fake_llm.script(debrief_reply(hold=True))
    sid = chat(harness, fake_llm, workspace)
    run_id = wait_for(lambda: learning.debriefing().get(sid), what="the debrief")
    wait_for(lambda: learning.open_nodes(run_id) == ["debrief"], what="its running node")
    sent = wait_for(lambda: [u for u in updates(harness, run_id) if u["current_nodes"] == ["debrief"]],
                    what="its run.updated")
    assert (sent[0]["status"], sent[0]["session_id"]) == ("running", sid)
    assert sent[0]["parent_run_id"] == harness.store.get_session(sid).run_ids[-1]
    fake_llm.release()
    wait_for(lambda: status(harness, sid) == "ended", what="the end")
    assert sid not in learning.debriefing() and learning.open_nodes(run_id) == []
    assert learning._debrief_updated(sid, run_id) is None  # a trailing event can't say running after the end


def test_a_fresh_run_shows_no_stale_nodes_before_its_worker_starts(harness, workspace, monkeypatch):
    sid = start(harness, workspace)
    live = harness._live[sid]
    old_run = live.run_id
    live.open_nodes.apply("NodeStarted", {"node_id": "chat#0/reply"})
    seen = {}
    real_spawn = harness._spawn

    def spawn(live_, kind, provider=None):
        seen.update(run_id=live_.run_id, nodes=harness.open_nodes(live_.run_id))
        return real_spawn(live_, kind, provider)

    monkeypatch.setattr(harness, "_spawn", spawn)
    live.worker = None  # as a restart does: its exit is no longer the session's
    harness.registry.close(sid)
    harness._new_run(live, RunEnd("interrupted", "replaced"))
    assert seen["run_id"] != old_run and seen["nodes"] == []


def claims_while_ending(harness, monkeypatch, claimed):
    """Record ``claimed(run_id)`` for each run as ``end_run`` writes its outcome."""
    seen, real = {}, harness.store.end_run

    def end_run(run_id, *args, **kwargs):
        seen.setdefault(run_id, claimed(run_id))
        return real(run_id, *args, **kwargs)

    monkeypatch.setattr(harness.store, "end_run", end_run)
    return seen


def test_a_harness_run_is_claimed_while_its_outcome_is_written(harness, workspace, monkeypatch):
    sid = start(harness, workspace)
    live = harness._live[sid]

    def claimed(run_id):
        runs, busy = harness.live_runs()
        return runs.get(sid) == run_id or sid in busy

    seen = claims_while_ending(harness, monkeypatch, claimed)
    harness._finish(live, "failed", None)
    assert seen == {live.run_id: True}


def test_a_debrief_is_claimed_while_its_outcome_is_written(harness, fake_llm, workspace, learning, monkeypatch):
    fake_llm.script(debrief_reply())
    seen = claims_while_ending(harness, monkeypatch, lambda run_id: run_id in learning.debriefing().values())
    sid = chat(harness, fake_llm, workspace)
    wait_for(lambda: status(harness, sid) == "ended", what="the end")
    chat_run = harness.store.get_session(sid).run_ids[-1]
    debriefs = {r: c for r, c in seen.items() if r != chat_run}
    assert debriefs and all(debriefs.values())
    assert learning.debriefing() == {} and learning._open == {}

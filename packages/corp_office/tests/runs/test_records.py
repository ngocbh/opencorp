"""Run status, current nodes, participants and replaces: from rows, sessions, questions and memory, never a log."""

from opencorp.runs.records import NO_OUTCOME, Live, Summaries, current_nodes, participants, status_of
from opencorp.store import RunRow, new_id
from tests.store.conftest import question, session, store  # noqa: F401

T = "2026-10-20T10:00:00.000Z"


def row(s, run_id, **over):
    return RunRow(**{"run_id": run_id, "session_id": s.id, "flow": "chat", "flow_path": "shared/flows/chat.yaml",
                     "driver": "ngocbh", "parent_run_id": None, "launched_at": T, **over})


def test_the_outcome_wins():
    s = session(status="idle", run_ids=["R"])
    assert status_of(row(s, "R", outcome="failed", reason="worker stopped"), s, Live()) == ("failed", "worker stopped")


def test_a_waiting_or_idle_sessions_current_run_has_its_status_awake_or_asleep():
    for st in ("idle", "waiting"):
        s = session(status=st, run_ids=["R"])
        assert status_of(row(s, "R"), s, Live()) == (st, None)


def test_a_busy_sessions_current_run_runs_only_with_its_live_run_or_wake():
    s = session(status="busy", run_ids=["R"])
    assert status_of(row(s, "R"), s, Live(runs=frozenset({(s.id, "R")}))) == ("running", None)
    assert status_of(row(s, "R"), s, Live(waking=frozenset({s.id}))) == ("running", None)
    assert status_of(row(s, "R"), s, Live(runs=frozenset({(s.id, "OTHER")}))) == ("interrupted", NO_OUTCOME)
    assert status_of(row(s, "R"), s, Live()) == ("interrupted", NO_OUTCOME)


def test_a_starting_sessions_current_run_is_running():
    s = session(status="starting", run_ids=["R"])
    assert status_of(row(s, "R"), s, Live()) == ("running", None)


def test_a_debrief_in_flight_runs_and_a_backward_job_leaves_a_finished_run_finished():
    s = session(status="debriefing", run_ids=["C"])
    live = Live(debriefs=frozenset({(s.id, "D")}))
    assert status_of(row(s, "D", flow="debrief"), s, live) == ("running", None)
    assert status_of(row(s, "C", outcome="finished"), s, live) == ("finished", None)


def test_an_earlier_run_of_a_live_session_with_no_outcome_is_interrupted():
    s = session(status="idle", run_ids=["OLD", "NEW"])
    assert status_of(row(s, "OLD"), s, Live()) == ("interrupted", NO_OUTCOME)


def test_current_nodes_by_status():
    sid = new_id()
    turn = question(sid, run_id="R", source="human_input", node_id="chat#3/ask")
    card = question(sid, run_id="R", source="human_input", node_id="chat#3/setup")
    asked = question(sid, run_id="R")  # ask_user: no node
    busy = Live(nodes=lambda run_id: ["chat#3/reply"])
    assert current_nodes("idle", "R", [turn], Live()) == (["chat#3/ask"], False, False)
    assert current_nodes("waiting", "R", [card], Live()) == (["chat#3/setup"], False, False)
    assert current_nodes("waiting", "R", [asked], busy) == (["chat#3/reply"], True, False)
    assert current_nodes("waiting", "R", [], Live()) == ([], False, True)
    assert current_nodes("running", "R", [], busy) == (["chat#3/reply"], False, False)
    assert current_nodes("finished", "R", [turn], busy) == ([], False, False)


def test_participants_put_the_employee_first_and_never_the_driver():
    assert participants("ngocbh", "minh", ["ngocbh", "lan", None, "lan", "kai"]) == ["minh", "lan", "kai"]


def test_participants_come_from_answers_and_side_chat_openers(store):  # noqa: F811
    s = store.create_session(session(status="idle"))
    top = new_id()
    store.add_session_run(s.id, top)
    store.add_run(row(s, top))
    q = store.add_question(question(s.id, run_id=top, source="human_input", node_id="chat#0/ask"))
    store.answer_question(q.id, "hi", "text", answered_by="kai")
    side = store.create_session(session(kind="side", status="ended"))
    kid = new_id()
    store.add_session_run(side.id, kid)
    store.add_run(row(side, kid, flow="side_chat", driver="lan", parent_run_id=top))
    built = Summaries(store, Live()).build([store.get_run(top)])
    assert (built[top].participants, built[top].children_total, built[top].children) == (["minh", "kai", "lan"], 1, [])
    shown = Summaries(store, Live()).build([store.get_run(top)], children={top: store.run_children([top])})
    assert [k.participants for k in shown[top].children] == [["minh"]]


def test_children_are_counted_and_the_newest_shown(store, monkeypatch):  # noqa: F811
    from opencorp.runs import records

    monkeypatch.setattr(records, "CHILDREN_SHOWN", 2)
    s = store.create_session(session(status="ended"))
    top = new_id()
    store.add_run(row(s, top))
    kids = []
    for _ in range(3):
        side = store.create_session(session(kind="side", status="ended"))
        kids.append(store.add_run(row(side, new_id(), flow="side_chat", parent_run_id=top)).run_id)
    built = Summaries(store, Live()).build([store.get_run(top)], children={top: store.run_children([top])})
    assert [k.run_id for k in built[top].children] == kids[:0:-1] and built[top].children_total == 3


def test_a_fresh_run_replaces_the_run_whose_end_is_its_launch(store):  # noqa: F811
    s = store.create_session(session(status="idle"))
    a, b = new_id(), new_id()
    for run_id in (a, b):
        store.add_session_run(s.id, run_id)
    store.add_run(row(s, a))
    store.end_run(a, "failed", reason="x", at=T)
    store.add_run(row(s, b, launched_at=T))
    built = Summaries(store, Live()).build(store.runs_of_session(s.id))
    assert (built[a].replaced_by, built[b].replaces, built[a].replaces, built[b].replaced_by) == (b, a, None, None)
    assert (built[a].status, built[b].status) == ("failed", "idle")


def test_a_reopened_side_chat_doesnt_replace_its_earlier_run(store):  # noqa: F811
    side = store.create_session(session(kind="side", status="idle"))
    a, b = new_id(), new_id()
    for run_id in (a, b):
        store.add_session_run(side.id, run_id)
    store.add_run(row(side, a, flow="side_chat"))
    store.end_run(a, "finished", at="2026-10-20T10:05:00.000Z")
    store.add_run(row(side, b, flow="side_chat", launched_at="2026-10-20T10:09:00.000Z"))
    assert Summaries(store, Live()).build(store.runs_of_session(side.id))[b].replaces is None


def test_two_live_reads_merge_so_a_run_live_in_either_is_live():
    first = Live(runs=frozenset({("A", "R1")}), waking=frozenset({"W"}), debriefs=frozenset({("D", "X")}))
    later = Live(runs=frozenset({("B", "R2")}), waking=frozenset({"V"}), nodes=lambda run_id: ["n"])
    both = first.merged(later)
    assert (both.runs, both.waking, both.debriefs) == ({("A", "R1"), ("B", "R2")}, {"W", "V"}, {("D", "X")})
    assert both.nodes("R2") == ["n"]


def test_a_build_reads_memory_again_after_the_store(store):  # noqa: F811
    s = store.create_session(session(status="busy"))
    run_id = new_id()
    store.add_session_run(s.id, run_id)
    store.add_run(row(s, run_id))
    reads = []

    def fresh():
        reads.append("fresh")
        return Live(runs=frozenset({(s.id, run_id)}))

    built = Summaries(store, Live(), fresh=fresh).build([store.get_run(run_id)])
    assert built[run_id].status == "running" and reads == ["fresh"]


def test_a_long_stored_reason_is_cut_to_be_shown(store):  # noqa: F811
    s = store.create_session(session(status="ended"))
    run_id = new_id()
    store.add_run(row(s, run_id))
    store.end_run(run_id, "failed", reason="x" * 1500)
    (built,) = Summaries(store, Live()).build([store.get_run(run_id)]).values()
    assert len(built.reason) == 200 and built.reason.endswith("…")
    cleaned = Summaries(store, Live(), clean=lambda text: text[:3]).build([store.get_run(run_id)])
    assert cleaned[run_id].reason == "xxx"

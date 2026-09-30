import os
import signal

from tests.chat.conftest import status, texts, wait_for


def start(harness, workspace):
    session = harness.start_session("minh", str(workspace))
    wait_for(lambda: status(harness, session.id) == "idle", what="the first turn")
    return session.id


def test_a_killed_worker_resumes_the_same_run(harness, fake_llm, workspace):
    fake_llm.script({"content": "one"}, {"content": "two"})
    sid = start(harness, workspace)
    harness.prompt(sid, "a")
    wait_for(lambda: texts(harness, sid) == ["one"] and status(harness, sid) == "idle", what="turn one")
    turn = harness._live[sid].turn_q
    old = harness._live[sid].worker
    os.killpg(old.pgid, signal.SIGKILL)
    wait_for(lambda: harness._live[sid].worker not in (None, old) and harness._live[sid].turn_q, what="the resume")
    assert harness._live[sid].turn_q == turn  # the same question, re-shown
    harness.prompt(sid, "b")
    wait_for(lambda: texts(harness, sid) == ["one", "two"], what="turn two")
    assert len(harness.store.get_session(sid).run_ids) == 1
    assert "a" in [m.parts[0].text for m in harness.store.list_messages(sid) if m.role == "user"]


def test_a_second_kill_in_a_row_fails_the_session(harness, fake_llm, workspace):
    sid = start(harness, workspace)
    first = harness._live[sid].worker
    os.killpg(first.pgid, signal.SIGKILL)
    second = wait_for(lambda: (w := harness._live[sid].worker) not in (None, first) and w, what="the resume")
    os.killpg(second.pgid, signal.SIGKILL)
    wait_for(lambda: status(harness, sid) == "failed", what="the failure")
    work_item = harness.store.get_session(sid).work_item_id
    assert harness.store.get_work_item(work_item).status == "in_progress"  # left open for the manager


def test_a_new_office_resumes_live_sessions(make_harness, fake_llm, workspace):
    fake_llm.script({"content": "one"}, {"content": "two"})
    first = make_harness()
    sid = start(first, workspace)
    first.prompt(sid, "a")
    wait_for(lambda: texts(first, sid) == ["one"] and status(first, sid) == "idle", what="turn one")
    first.close_all()
    assert status(first, sid) == "idle"  # left for the next office

    second = make_harness()
    second.restore()
    wait_for(lambda: sid in second._live and second._live[sid].turn_q, what="the restored turn")
    second.prompt(sid, "b")
    wait_for(lambda: texts(second, sid) == ["one", "two"], what="turn two")
    assert len(second.store.get_session(sid).run_ids) == 1
    assert "one" in str(fake_llm.requests()[1]["messages"])  # the resumed run kept the conversation


def test_max_turns_counts_turns_from_before_a_worker_restart(make_harness, fake_llm, workspace):
    harness = make_harness(defaults={"max_turns": 2})
    fake_llm.script({"content": "one"}, {"content": "two"})
    sid = start(harness, workspace)
    harness.prompt(sid, "a")
    wait_for(lambda: texts(harness, sid) == ["one"] and status(harness, sid) == "idle", what="turn one")
    old = harness._live[sid].worker
    os.killpg(old.pgid, signal.SIGKILL)
    wait_for(lambda: harness._live[sid].worker not in (None, old) and harness._live[sid].turn_q, what="the resume")
    harness.prompt(sid, "b")
    wait_for(lambda: status(harness, sid) == "ended", what="the end")


def test_an_office_that_dies_mid_turn_is_reaped_and_its_run_resumed(make_harness, fake_llm, workspace):
    fake_llm.script({"content": "never seen", "hold": True}, {"content": "Resumed."})
    first = make_harness()
    sid = start(first, workspace)
    first.prompt(sid, "a")
    fake_llm.wait_for_requests(1)
    old = first._live[sid].worker
    run_id = first.store.get_session(sid).run_ids[0]
    first._stopping = True  # the office died: nothing of it acts on its worker again

    second = make_harness()
    second.restore()  # spawn reaps the dead office's worker, then resumes the run
    assert old.wait(10) is not None
    fake_llm.release()
    wait_for(lambda: texts(second, sid)[-1:] == ["Resumed."] and status(second, sid) == "idle", what="the resumed turn")
    assert second.store.get_session(sid).run_ids == [run_id]
    assert "a" in str(fake_llm.requests()[-1]["messages"])


def test_a_worker_that_cant_start_at_restore_fails_only_its_session(make_harness, fake_llm, workspace):
    from agent_corp.chat.provider import ProviderError

    first = make_harness()
    sids = {start(first, workspace), start(first, workspace)}
    first.close_all()

    second = make_harness()
    good, calls = second.provider, []

    def once_bad():
        calls.append(1)
        if len(calls) == 1:
            raise ProviderError("provider.json must be a regular file private to its owner (mode 0600)")
        return good()

    second.provider = once_bad
    second.restore()  # doesn't raise
    (restored,) = wait_for(lambda: [sid for sid in sids if sid in second._live and second._live[sid].turn_q],
                           what="the other session's turn")
    (failed,) = sids - {restored}
    assert status(second, failed) == "failed" and status(second, restored) == "idle"


def test_a_session_whose_tool_parts_cant_be_swept_at_restore_fails_alone(make_harness, fake_llm, workspace):
    first = make_harness()
    sids = [start(first, workspace), start(first, workspace)]
    first.close_all()

    second = make_harness()
    sweep = second._interrupt_running_tools

    def once_broken(session_id):
        if session_id == sids[0]:
            raise RuntimeError("the store can't read this session's messages")
        sweep(session_id)

    second._interrupt_running_tools = once_broken
    second.restore()  # doesn't raise
    assert status(second, sids[0]) == "failed" and sids[0] not in second._live
    wait_for(lambda: sids[1] in second._live and second._live[sids[1]].turn_q, what="the other session's turn")


def test_restore_fails_a_live_session_that_never_got_a_run(make_harness, fake_llm, workspace):
    from agent_corp.store import new_id

    first = make_harness()
    sid = start(first, workspace)
    orphan = first.store.create_session(first.store.get_session(sid).model_copy(
        update={"id": new_id(), "run_ids": [], "status": "starting"}))  # the office died before its run
    first.close_all()

    second = make_harness()
    ended = []
    second.hooks.session_ended.append(lambda session: ended.append((session.id, session.status)))
    second.restore()
    assert status(second, orphan.id) == "failed" and orphan.id not in second._live
    assert ended == [(orphan.id, "failed")]
    wait_for(lambda: sid in second._live and second._live[sid].turn_q, what="the restored turn")


def test_a_worker_that_dies_again_after_good_turns_resumes_again(harness, fake_llm, workspace):
    fake_llm.script(*({"content": f"r{n}"} for n in range(5)))
    sid = start(harness, workspace)
    first = harness._live[sid].worker
    os.killpg(first.pgid, signal.SIGKILL)
    second = wait_for(lambda: (w := harness._live[sid].worker) not in (None, first) and harness._live[sid].turn_q
                      and w, what="the resume")
    for n in range(3):
        harness.prompt(sid, f"t{n}")
        wait_for(lambda: len(texts(harness, sid)) == n + 1 and status(harness, sid) == "idle", what=f"turn {n}")
    os.killpg(second.pgid, signal.SIGKILL)
    wait_for(lambda: (w := harness._live[sid].worker) not in (None, second) and harness._live[sid].turn_q,
             what="the second resume")
    harness.prompt(sid, "t3")
    wait_for(lambda: texts(harness, sid)[-1:] == ["r3"], what="the turn after it")


def test_a_session_ending_when_the_office_stops_ends_after_restore(make_harness, fake_llm, workspace):
    fake_llm.script({"content": "slow", "hold": True}, {"content": "done"})
    first = make_harness()
    sid = start(first, workspace)
    first.prompt(sid, "a")
    fake_llm.wait_for_requests(1)
    first._live[sid].worker.interrupt = lambda node: True  # the office stops before the worker sees the end
    first.end(sid)
    assert status(first, sid) == "ending"
    first.close_all()
    fake_llm.release()

    second = make_harness()
    second.restore()
    wait_for(lambda: status(second, sid) == "ended", what="the end")


def half_a_reply(live):
    """Leave a half-streamed text part and a running tool part in the session's transcript."""
    live.transcript.event("ModelCallStarted", {"node_id": "chat#0/reply", "exchange_id": "x1", "purpose": "chat"})
    live.transcript.stream({"type": "stream", "node_id": "chat#0/reply", "key": "reply", "chunk": "half",
                            "final": False, "exchange_id": "x1"})
    live.transcript.stream({"type": "stream", "node_id": "chat#0/reply", "key": "reply", "chunk": " a reply",
                            "final": False, "exchange_id": "x1"})
    live.transcript.event("ToolCallStarted", {"node_id": "chat#0/reply", "tool_call_id": "c1", "name": "shell",
                                              "arguments": {"command": "sleep 9"}})


def assistant_parts(harness, sid):
    return [(p.type, p.text if p.type == "text" else p.state)
            for m in harness.store.list_messages(sid) if m.role == "assistant" for p in m.parts]


def test_a_killed_worker_leaves_no_part_unfinished(harness, workspace):
    sid = start(harness, workspace)
    old = harness._live[sid].worker
    half_a_reply(harness._live[sid])
    os.killpg(old.pgid, signal.SIGKILL)
    wait_for(lambda: harness._live[sid].worker not in (None, old) and harness._live[sid].turn_q, what="the resume")
    assert assistant_parts(harness, sid) == [("text", "half a reply\n\n[interrupted]"), ("tool", "interrupted")]


def test_a_stopping_office_leaves_no_part_unfinished(harness, workspace):
    sid = start(harness, workspace)
    half_a_reply(harness._live[sid])
    harness.close_all()
    assert assistant_parts(harness, sid) == [("text", "half a reply\n\n[interrupted]"), ("tool", "interrupted")]


def test_restore_interrupts_tool_parts_a_dead_office_left_running(make_harness, workspace):
    first = make_harness()
    sid = start(first, workspace)
    half_a_reply(first._live[sid])
    first._stopping = True  # the office died: nothing of it acts on its worker again

    second = make_harness()
    second.restore()
    # The text part keeps what was stored at its first chunk: a text part has no state to mark.
    assert assistant_parts(second, sid) == [("text", "half"), ("tool", "interrupted")]

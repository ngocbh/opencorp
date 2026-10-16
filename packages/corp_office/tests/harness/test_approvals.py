"""Codex requests as cards: store, then reply; first answer wins; stale when Codex no longer waits."""

import os
import signal
import threading

from agent_corp.chat.harness import HarnessError
from agent_corp.harness import session as session_module
from agent_corp.testing import fake_codex as fc
from tests.harness.conftest import start, status, wait_for


def open_card(harness, sid):
    return wait_for(lambda: next(iter(harness.store.list_questions(session_id=sid, status="open")), None),
                    what="a card")


def approval_turn(request_id=1, wait=True):
    return [fc.command_started("c1", "touch a"), fc.command_approval(request_id, "c1", "touch a", wait=wait),
            fc.command("c1", "touch a")[1]]


def test_an_approval_is_an_open_card_on_a_busy_session(harness, fake_codex, workspace):
    fake_codex.script([approval_turn()])
    sid = start(harness, workspace)
    harness.prompt(sid, "make a")
    q = open_card(harness, sid)
    assert (q.source, q.run_id, q.node_id, q.asker, q.options[0]) == ("harness", "turn_1", "1", "minh", "Approve")
    assert status(harness, sid) == "busy"  # the session stays busy while a card is open


def test_a_request_no_card_can_be_made_from_gets_a_json_rpc_error(harness, fake_codex, workspace):
    broken = fc.command_approval(3, "c1", "touch a")
    del broken["params"]["itemId"]  # not as the pinned schema says: Codex would otherwise wait on it until Esc
    fake_codex.script([[broken]])
    sid = start(harness, workspace)
    harness.prompt(sid, "make a")
    wait_for(lambda: 3 in fake_codex.replies(), what="the error reply")
    assert fake_codex.replies()[3]["code"] == -32603
    wait_for(lambda: status(harness, sid) == "idle", what="Codex going on")
    assert harness.store.list_questions(session_id=sid) == []


def tool_parts(harness, sid):
    return [p for m in harness.store.list_messages(sid) for p in m.parts if p.type == "tool"]


def test_an_approvals_answer_is_codexs_reply_and_its_resolved_leaves_the_card_consumed(harness, fake_codex,
                                                                                       workspace):
    fake_codex.script([approval_turn()])
    sid = start(harness, workspace)
    harness.prompt(sid, "make a")
    q = open_card(harness, sid)
    assert harness.answer(q.id, "Approve", "option", by="ngocbh").status == "consumed"
    wait_for(lambda: fake_codex.replies().get(1) == {"decision": "accept"}, what="the reply")
    wait_for(lambda: any(m.get("method") == "serverRequest/resolved" and m["params"]["requestId"] == 1
                         for m in fake_codex.messages("out")), what="Codex's resolved")
    wait_for(lambda: status(harness, sid) == "idle", what="the turn's end")
    got = harness.store.get_question(q.id)
    assert (got.status, got.answer, got.answered_by) == ("consumed", "Approve", "ngocbh")
    [part] = tool_parts(harness, sid)
    assert part.input["approval"] == {"decision": "accept", "by": "ngocbh"} and part.state == "completed"


def test_an_approval_answered_after_a_steer_lands_on_the_commands_part(harness, fake_codex, workspace):
    fake_codex.script([approval_turn()])
    sid = start(harness, workspace)
    harness.prompt(sid, "make a", by="ngocbh")
    q = open_card(harness, sid)
    assert harness.prompt(sid, "and b", by="ngocbh") == "steer"
    harness.answer(q.id, "Approve", "option", by="ngocbh")
    wait_for(lambda: status(harness, sid) == "idle", what="the turn's end")
    assert [(p.state, p.input["approval"]["decision"]) for p in tool_parts(harness, sid)] == [("completed", "accept")]


def test_an_answer_no_reply_can_be_made_from_tells_codex_it_failed(harness, fake_codex, workspace):
    fake_codex.script([approval_turn()])
    sid = start(harness, workspace)
    harness.prompt(sid, "make a")
    q = open_card(harness, sid)
    # No Cards here to check it first, as on a route without them: "Maybe" isn't one of the options.
    assert harness.answer(q.id, "Maybe", "option", by="ngocbh").status == "stale"
    wait_for(lambda: 1 in fake_codex.replies(), what="the error reply")
    assert fake_codex.replies()[1]["code"] == -32602
    wait_for(lambda: status(harness, sid) == "idle", what="Codex going on")
    assert all("approval" not in p.input for p in tool_parts(harness, sid))


def test_an_answer_with_no_named_sender_is_the_openers(harness, fake_codex, workspace):
    fake_codex.script([approval_turn()])
    sid = start(harness, workspace, by="ngocbh")
    harness.prompt(sid, "make a")
    q = open_card(harness, sid)
    assert harness.answer(q.id, "Approve", "option").answered_by == "ngocbh"
    wait_for(lambda: status(harness, sid) == "idle", what="the turn's end")
    [part] = tool_parts(harness, sid)
    assert part.input["approval"]["by"] == "ngocbh"


def test_office_stop_makes_an_answer_waiting_for_its_reply_give_up_at_once(harness, fake_codex, workspace,
                                                                          monkeypatch):
    fake_codex.script([approval_turn()])
    sid = start(harness, workspace)
    harness.prompt(sid, "make a")
    q = open_card(harness, sid)
    live = harness.codex._live[sid]
    monkeypatch.setattr(session_module, "STOP_WAIT", 0.2)
    began, release = threading.Event(), threading.Event()

    def hold():  # a job the stop can't wait out, with the reply's job queued behind it
        began.set()
        release.wait(10)
    live._post(hold)
    assert began.wait(5)
    results = []
    answering = threading.Thread(target=lambda: results.append(
        harness.answer(q.id, "Approve", "option", by="ngocbh").status))
    answering.start()
    wait_for(lambda: live._jobs.qsize() == 1, what="the reply's job")
    harness.close_all()
    answering.join(5)
    release.set()
    assert results == ["stale"] and 1 not in fake_codex.replies()


def test_two_answerers_make_one_reply(harness, fake_codex, workspace):
    fake_codex.script([approval_turn()])
    sid = start(harness, workspace)
    harness.prompt(sid, "make a")
    q = open_card(harness, sid)
    results, go = [], threading.Barrier(2)

    def answer(choice):
        go.wait()
        try:
            results.append(harness.answer(q.id, choice, "option", by="ngocbh").status)
        except HarnessError as e:
            results.append(e.code)

    threads = [threading.Thread(target=answer, args=(c,)) for c in ("Approve", "Deny and stop")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(results) == ["consumed", "not_open"]
    wait_for(lambda: 1 in fake_codex.replies(), what="the one reply")
    assert sum(1 for m in fake_codex.messages() if m.get("id") == 1 and "method" not in m) == 1
    # What Codex got is what the store kept.
    stored = harness.store.get_question(q.id).answer
    assert fake_codex.replies()[1] == {"decision": {"Approve": "accept", "Deny and stop": "cancel"}[stored]}


def test_an_answer_that_codex_resolved_first_goes_stale_with_no_reply(harness, fake_codex, workspace, monkeypatch):
    fake_codex.script([[fc.command_approval(1, "c1", "touch a", wait=False), {"sleep": 5}]])
    sid = start(harness, workspace)
    harness.prompt(sid, "make a")
    q = open_card(harness, sid)
    live = harness.codex._live[sid]
    stored = harness.store.answer_question

    def answer_then_resolve(*args, **kwargs):  # Codex resolves between the store and the reply
        got = stored(*args, **kwargs)
        live._resolved(1)
        return got

    monkeypatch.setattr(harness.store, "answer_question", answer_then_resolve)
    assert harness.answer(q.id, "Approve", "option", by="ngocbh").status == "stale"
    assert 1 not in fake_codex.replies()
    assert all("approval" not in p.input for p in tool_parts(harness, sid))


def test_an_answer_after_the_app_server_died_goes_stale(harness, fake_codex, workspace):
    fake_codex.script([approval_turn()])
    sid = start(harness, workspace)
    harness.prompt(sid, "make a")
    q = open_card(harness, sid)
    os.kill(harness.store.list_workers()[0].pid, signal.SIGKILL)
    wait_for(lambda: not harness.codex._live[sid].process or not harness.codex._live[sid].process.alive, what="death")
    try:
        assert harness.answer(q.id, "Approve", "option", by="ngocbh").status == "stale"
    except HarnessError as e:
        assert e.code == "not_open"  # the app-server's exit expired the card first
    assert 1 not in fake_codex.replies()

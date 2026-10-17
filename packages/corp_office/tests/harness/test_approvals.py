"""Codex requests as cards: store, then reply; first answer wins; stale when Codex no longer waits."""

import os
import signal
import threading
from types import SimpleNamespace

import pytest

from agent_corp.chat.harness import HarnessError
from agent_corp.extensions.questions import register
from agent_corp.harness import session as session_module
from agent_corp.harness.sessions import _masked
from agent_corp.protocol.models import QuestionPage
from agent_corp.store import DuplicateKey, StoreError
from agent_corp.testing import fake_codex as fc
from tests.harness.conftest import start, status, wait_for
from tests.store.conftest import question

SENTINEL = "sk-ant-sentinel-a7d93c10e5b2"
SID = "01M53FTBYV710JBB471KEBQDVC"


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


def test_a_card_the_store_refuses_is_an_error_reply_and_the_turn_still_ends(harness, fake_codex, workspace,
                                                                           monkeypatch):
    fake_codex.script([[fc.command_approval(1, "c1", "touch a", wait=False), {"sleep": 0.3}]])
    sid = start(harness, workspace)
    live = harness.codex._live[sid]

    def refuse(question):
        raise DuplicateKey(f"question {question.run_id}/{question.node_id} exists")

    monkeypatch.setattr(harness.store, "add_question", refuse)
    harness.prompt(sid, "make a")
    wait_for(lambda: 1 in fake_codex.replies(), what="the error reply")
    assert fake_codex.replies()[1]["code"] == -32603
    wait_for(lambda: status(harness, sid) == "idle", what="the turn's end")
    assert live.requests == {} and live.by_request == {}
    live._expire("no-such-question")  # a card that is gone expires quietly


def test_turnless_cards_of_two_app_servers_with_one_pid_dont_collide(harness, fake_codex, workspace):
    step = fc.url_elicitation(8, "gh", "Sign in", "https://e.com/l", wait=False)
    fake_codex.script([[step, {"sleep": 5}]])
    sid = start(harness, workspace)
    harness.prompt(sid, "sign in")
    first = open_card(harness, sid)
    live = harness.codex._live[sid]
    real, errors = live.process, []
    # A later app-server of this session that got the same pid, and numbers its requests from the same start.
    twin = SimpleNamespace(pid=real.pid, alive=True, rpc=SimpleNamespace(
        reply_error=lambda request_id, code, message: errors.append((request_id, code))))
    ran = threading.Event()
    with live._lock:
        live.process = twin
    try:
        live._post(live._request, twin, 8, step["request"], fc.fill(step["params"], "", str(workspace), "thr_1"))
        live._post(ran.set)
        assert ran.wait(5)
    finally:
        with live._lock:
            live.process = real
    cards = harness.store.list_questions(session_id=sid, status="open")
    assert errors == [] and len(cards) == 2 and len({q.run_id for q in cards}) == 2
    assert all(q.run_id.startswith("codex-") for q in cards) and first in cards


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


def test_an_unanswered_card_goes_stale_when_codex_resolves_it(harness, fake_codex, workspace):
    fake_codex.script([[fc.command_approval(1, "c1", "touch a", wait=False), {"sleep": 0.3}, {"resolve": 1},
                        {"sleep": 5}]])
    sid = start(harness, workspace)
    harness.prompt(sid, "make a")
    q = open_card(harness, sid)
    wait_for(lambda: harness.store.get_question(q.id).status == "stale", what="stale")
    assert status(harness, sid) == "busy"  # the turn goes on


def test_a_card_codex_left_waiting_at_its_turns_end_goes_stale(harness, fake_codex, workspace):
    fake_codex.script([[fc.command_approval(1, "c1", "touch a", wait=False), {"sleep": 0.3}]])
    sid = start(harness, workspace)
    harness.prompt(sid, "make a")
    q = open_card(harness, sid)
    wait_for(lambda: status(harness, sid) == "idle", what="the turn's end")
    assert not any(m.get("method") == "serverRequest/resolved" for m in fake_codex.messages("out"))
    wait_for(lambda: harness.store.get_question(q.id).status == "stale", what="stale")


def test_two_cards_open_and_close_independently_and_a_message_leaves_them_alone(harness, fake_codex, workspace):
    fake_codex.script([[fc.command_approval(1, "c1", "touch a", wait=False),
                        fc.permissions_approval(2, "p1", wait=False), {"wait_reply": 1}, {"wait_reply": 2}]])
    sid = start(harness, workspace)
    harness.prompt(sid, "go")
    wait_for(lambda: len(harness.store.list_questions(session_id=sid, status="open")) == 2, what="two cards")
    assert harness.prompt(sid, "also do b") == "steer"
    by_node = {q.node_id: q for q in harness.store.list_questions(session_id=sid, status="open")}
    assert harness.answer(by_node["2"].id, "Approve for this session", "option", by="ngocbh").status == "consumed"
    assert harness.store.get_question(by_node["1"].id).status == "open"
    assert harness.answer(by_node["1"].id, "Approve", "option", by="ngocbh").status == "consumed"
    wait_for(lambda: status(harness, sid) == "idle", what="the turn's end")
    assert fake_codex.replies()[2]["scope"] == "session" and fake_codex.replies()[1] == {"decision": "accept"}


def test_esc_makes_open_cards_stale_though_codex_never_resolves_them(harness, fake_codex, workspace, monkeypatch):
    fake_codex.script([approval_turn()])
    sid = start(harness, workspace)
    harness.prompt(sid, "make a")
    q = open_card(harness, sid)
    # Real Codex sends no serverRequest/resolved for a request an interrupt leaves waiting; the fake does.
    monkeypatch.setattr(harness.codex._live[sid], "_resolved", lambda request_id: None)
    harness.interrupt(sid)
    wait_for(lambda: harness.store.get_question(q.id).status == "stale" and status(harness, sid) == "idle",
             what="stale card, idle session")
    with pytest.raises(HarnessError) as refused:
        harness.answer(q.id, "Approve", "option", by="ngocbh")
    assert refused.value.code == "not_open" and 1 not in fake_codex.replies()


def test_a_secret_answer_reaches_codex_and_never_the_store(harness, fake_codex, workspace):
    fake_codex.script([[fc.user_input(4, "u1", [fc.question("token", "Token", "Paste it", secret=True),
                                                fc.question("env", "Env", "Where?", options=["prod", "dev"])])]])
    sid = start(harness, workspace)
    harness.prompt(sid, "deploy")
    q = open_card(harness, sid)
    assert [p.secret for p in q.questions] == [True, False]
    got = harness.answer(q.id, {"Token": SENTINEL, "Env": "dev"}, "text", by="ngocbh")
    assert got.status == "consumed" and got.answer == {"Token": "[secret]", "Env": "dev"}
    wait_for(lambda: fake_codex.replies().get(4) == {"answers": {"token": {"answers": [SENTINEL]},
                                                                 "env": {"answers": ["dev"]}}}, what="the reply")
    wait_for(lambda: status(harness, sid) == "idle", what="the turn's end")
    assert harness.store.get_question(q.id).answer == {"Token": "[secret]", "Env": "dev"}
    paths = harness.office.paths
    # The store runs in WAL mode: the secret could sit in store.sqlite-wal before a checkpoint.
    stores = sorted(paths.store.parent.glob(paths.store.name + "*"))
    assert len(stores) >= 2 and all(SENTINEL.encode() not in p.read_bytes() for p in stores)
    assert SENTINEL not in (paths.run_dir(sid) / "codex.log").read_text()
    assert all(SENTINEL not in str(e.data) for e in harness.store.events_after())
    assert all(SENTINEL not in str(e) for e in harness.office.bus.events)


def test_an_unserved_request_gets_a_json_rpc_error(harness, fake_codex, workspace):
    fake_codex.script([[{"request": "item/tool/call", "id": 9, "wait": True, "params": {
        "threadId": "{thread}", "turnId": "{turn}", "callId": "x", "namespace": None, "tool": "t", "arguments": {}}}]])
    sid = start(harness, workspace)
    harness.prompt(sid, "go")
    wait_for(lambda: 9 in fake_codex.replies(), what="the error reply")
    assert fake_codex.replies()[9]["code"] == -32601
    wait_for(lambda: status(harness, sid) == "idle", what="Codex going on")
    assert harness.store.list_questions(session_id=sid) == []


def test_cards_answer_a_codex_card_and_refuse_its_other_actions(harness, fake_codex, workspace):
    harness.office.extras, harness.office.on_start, harness.office.on_stop = {"harness": harness}, [], []
    register(harness.office)
    cards = harness.office.extras["cards"]
    try:
        fake_codex.script([approval_turn()])
        sid = start(harness, workspace)
        harness.prompt(sid, "make a")
        q = open_card(harness, sid)
        with pytest.raises(HarnessError):
            cards.answer(q.id, "approve it please", "text", by="ngocbh")  # an approval takes an option
        for refused in (lambda: cards.open_side(q.id, "why?", by="ngocbh"),
                        lambda: cards.send_back(q.id, "", by="ngocbh"), lambda: cards.stop(q.id, by="ngocbh")):
            with pytest.raises(HarnessError) as e:
                refused()
            assert e.value.code == "harness_card"
        assert harness.store.get_question(q.id).status == "open"
        assert cards.answer(q.id, "Approve", "option", by="ngocbh").status == "consumed"
        wait_for(lambda: fake_codex.replies().get(1) == {"decision": "accept"}, what="the reply")
    finally:
        cards.close()


def test_an_answer_that_waited_too_long_for_its_reply_tells_codex_it_came_too_late(harness, fake_codex, workspace,
                                                                                   monkeypatch):
    fake_codex.script([approval_turn()])
    sid = start(harness, workspace)
    harness.prompt(sid, "make a")
    q = open_card(harness, sid)
    live = harness.codex._live[sid]
    monkeypatch.setattr(session_module, "REPLY_WAIT", 0.2)
    began, release = threading.Event(), threading.Event()

    def hold():  # the session's thread is busy past the answer's wait
        began.set()
        release.wait(10)
    live._post(hold)
    assert began.wait(5)
    assert harness.answer(q.id, "Approve", "option", by="ngocbh").status == "stale"
    release.set()
    wait_for(lambda: 1 in fake_codex.replies(), what="the error reply")
    assert fake_codex.replies()[1]["code"] == -32603  # with no card left, Codex mustn't wait on one
    wait_for(lambda: status(harness, sid) == "idle", what="Codex going on")
    assert live.requests == {} and harness.store.get_question(q.id).status == "stale"


def test_on_a_card_with_a_secret_only_what_is_known_to_be_safe_is_stored():
    pages = [QuestionPage(question="Paste it", header="Token", options=[], secret=True),
             QuestionPage(question="Where?", header="Env", options=[])]
    secret_card = question(SID, source="harness", questions=pages)
    assert _masked(secret_card, {"Token": SENTINEL, "Env": "dev"}) == {"Token": "[secret]", "Env": "dev"}
    assert _masked(secret_card, {"Env": "dev", "Tokn": SENTINEL}) == {"Env": "dev", "Tokn": "[secret]"}
    assert _masked(secret_card, SENTINEL) == "[secret]"
    assert _masked(secret_card, [SENTINEL]) == "[secret]"
    plain = question(SID, source="harness", questions=[pages[1]])
    assert _masked(plain, {"Env": "dev", "Other": "x"}) == {"Env": "dev", "Other": "x"}
    assert _masked(question(SID, source="harness", options=["Approve"]), "Approve") == "Approve"


def test_a_card_that_cant_be_marked_consumed_after_the_reply_still_answers(harness, fake_codex, workspace,
                                                                          monkeypatch):
    fake_codex.script([approval_turn()])
    sid = start(harness, workspace)
    harness.prompt(sid, "make a")
    q = open_card(harness, sid)
    moved = harness.store.set_question_status

    def failing(question_id, to):
        if to == "consumed":
            raise StoreError("the disk is full")
        return moved(question_id, to)

    monkeypatch.setattr(harness.store, "set_question_status", failing)
    # Codex has the reply: the answer stands, as answered, rather than failing the request.
    assert harness.answer(q.id, "Approve", "option", by="ngocbh").status == "answered"
    wait_for(lambda: fake_codex.replies().get(1) == {"decision": "accept"}, what="the reply")
    wait_for(lambda: status(harness, sid) == "idle", what="the turn's end")
    [part] = tool_parts(harness, sid)
    assert part.input["approval"] == {"decision": "accept", "by": "ngocbh"}

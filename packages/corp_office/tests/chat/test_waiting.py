"""The run state the composer harness writes: waiting (and on whom), busy, idle."""

from opencorp.chat.provider import Price
from opencorp.protocol import now
from opencorp.protocol.models import Question
from opencorp.questions.format import INTERRUPTED
from opencorp.store import new_id
from tests.chat.conftest import status, wait_for
from tests.company.conftest import person
from tests.questions.test_cards import GATE
from tests.store.conftest import session

ASK_USER = {"tool_calls": [{"name": "ask_user", "arguments": {"question": "Which?", "options": ["A", "B"]}}]}
ASK_MANAGER = {"tool_calls": [{"name": "ask_manager", "arguments": {"question": "Budget?"}}]}
PRICEY = {"content": "pricey", "usage": {"prompt_tokens": 6, "completion_tokens": 1}}
LAN = {"people/lan/person.yaml": {"handle": "lan", "name": "Lan", "kind": "human", "title": "Designer",
                                  "manager": "ngocbh"}}
KAI = {"people/kai/person.yaml": person("minh", handle="kai", name="Kai"),
       "people/minh/person.yaml": person("minh", manager="kai")}  # an agent manager
GATE_FILES = {"people/minh/gate.yaml": GATE, "people/minh/person.yaml": person("minh", main="gate.yaml")}
GATE_ANSWER = {"db": "Postgres", "features": ["auth"]}


def start(harness, workspace, **kw):
    sid = harness.start_session("minh", str(workspace), **kw).id
    wait_for(lambda: status(harness, sid) == "idle", what="the first turn")
    return sid


def state(harness, sid):
    s = harness.store.get_session(sid)
    return s.status, s.waiting_on


def card(harness, sid, source):
    return wait_for(lambda: harness.store.list_questions(session_id=sid, status="open", source=source),
                    what=f"the {source} card")[0]


def cap_item(harness):
    return next((w for w in harness.store.list_work_items(status=("open", "in_progress"))
                 if w.title.startswith("Raise the cost cap")), None)


def at_the_gate(harness, workspace):
    """Start minh's gate flow; return the session id and its open card once it waits there."""
    sid = harness.start_session("minh", str(workspace)).id
    q = wait_for(lambda: harness.store.list_questions(session_id=sid, status="open"), what="the gate")[0]
    wait_for(lambda: state(harness, sid) == ("waiting", ["ngocbh"]), what="waiting at the node")
    return sid, q


def test_a_failed_waiting_session_waits_on_no_one(harness):
    s = harness.store.create_session(session(status="waiting", waiting_on=["ngocbh"], capped=True))
    harness._fail(s.id)
    got = harness.store.get_session(s.id)
    assert (got.status, got.waiting_on, got.capped) == ("failed", [], False)


def test_settle_gives_idle_at_the_turn_and_busy_while_a_live_run_has_no_turn(harness, workspace):
    sid = start(harness, workspace)
    harness._settle(sid)
    assert state(harness, sid) == ("idle", [])
    with harness._lock:
        harness._live[sid].turn_q = None  # as _restart, a crash resume and a wake leave it until the turn shows
    harness._settle(sid)
    assert state(harness, sid) == ("busy", [])


def test_settle_waits_on_the_ceo_for_a_question_beside_the_turn(harness, workspace):
    sid = start(harness, workspace)
    run, t = harness.store.get_session(sid).run_ids[-1], now()
    harness.store.add_question(Question(id=new_id(), session_id=sid, run_id=run, node_id="gate", source="human_input",
                                        asker="minh", question="Which db?", status="open", created_at=t, updated_at=t))
    harness._settle(sid)
    assert state(harness, sid) == ("waiting", ["ngocbh"])  # no opener: the pinned CEO


def test_settle_holds_a_session_over_its_cap_on_its_manager(harness, workspace):
    sid = start(harness, workspace)
    harness.store.update_session(sid, cost=6)  # over the company's $5
    harness._settle(sid)
    assert state(harness, sid) == ("waiting", ["ngocbh"]) and harness.store.get_session(sid).capped


def test_settle_leaves_a_session_whose_finish_is_in_flight(harness, workspace):
    sid = start(harness, workspace)
    with harness._lock:
        live = harness._live.pop(sid)
        harness._finishing.add(sid)
    harness.store.update_session(sid, status="busy")
    harness._settle(sid)
    assert status(harness, sid) == "busy"  # not idle: _finish stores the end
    with harness._lock:
        harness._finishing.discard(sid)
        harness._live[sid] = live


def test_the_turn_alone_is_idle_and_a_running_reply_is_busy(harness, fake_llm, workspace):
    fake_llm.script({"content": "slow", "hold": 30})
    sid = start(harness, workspace)
    harness.prompt(sid, "hi")
    wait_for(lambda: status(harness, sid) == "busy", what="busy")
    fake_llm.wait_for_requests(1)  # held only once it arrives
    fake_llm.release()
    wait_for(lambda: state(harness, sid) == ("idle", []), what="idle again")


def test_ask_user_waits_on_the_opener_else_the_pinned_ceo(make_harness, fake_llm, workspace):
    h = make_harness(files=LAN)
    fake_llm.script(ASK_USER, ASK_USER, {"content": "A it is."})
    a = start(h, workspace, opened_by="lan")
    h.prompt(a, "hi")
    card(h, a, "ask_user")
    wait_for(lambda: state(h, a) == ("waiting", ["lan"]), what="waiting on lan")
    b = start(h, workspace)
    h.prompt(b, "hi")
    card(h, b, "ask_user")
    wait_for(lambda: state(h, b) == ("waiting", ["ngocbh"]), what="waiting on the CEO")
    h.prompt(a, "A")  # the answer
    wait_for(lambda: state(h, a)[0] != "waiting" and state(h, a)[1] == [], what="no longer waiting")


def test_ask_manager_waits_on_its_items_assignee_even_an_agent(make_harness, fake_llm, workspace):
    h = make_harness(files=KAI)
    fake_llm.script(ASK_MANAGER)
    sid = start(h, workspace)
    h.prompt(sid, "hi")
    card(h, sid, "ask_manager")
    wait_for(lambda: state(h, sid) == ("waiting", ["kai"]), what="waiting on kai")


def test_a_question_beside_the_open_turn_is_waiting(harness, workspace):
    sid = start(harness, workspace)
    run, t = harness.store.get_session(sid).run_ids[-1], now()
    harness.store.add_question(Question(id=new_id(), session_id=sid, run_id=run, node_id="gate", source="human_input",
                                        asker="minh", question="Which db?", status="open", created_at=t, updated_at=t))
    wait_for(lambda: state(harness, sid) == ("waiting", ["ngocbh"]), what="waiting")


def test_a_gate_flow_waits_at_its_node_from_starting(make_harness, workspace):
    h = make_harness(files=GATE_FILES)
    at_the_gate(h, workspace)  # starting moves straight to waiting


def test_ending_a_waiting_session_clears_waiting_on(harness, fake_llm, workspace):
    fake_llm.script(ASK_USER)
    sid = start(harness, workspace)
    harness.prompt(sid, "hi")
    card(harness, sid, "ask_user")
    wait_for(lambda: status(harness, sid) == "waiting", what="waiting")
    harness.end(sid)
    wait_for(lambda: state(harness, sid) == ("ended", []), what="the end")


def test_the_cost_hold_waits_on_the_cap_item_then_the_manager_and_raising_the_cap_frees_it(make_harness, fake_llm,
                                                                                         workspace):
    h = make_harness(prices={"stub": Price(input=1_000_000, output=0)}, files=LAN)
    fake_llm.script(PRICEY)
    sid = start(h, workspace)
    h.prompt(sid, "hi")
    # Held from the charge on, while the reply still runs: wait for the turn it opens.
    wait_for(lambda: cap_item(h) and state(h, sid) == ("waiting", ["ngocbh"]) and h._live[sid].turn_q,
             what="the hold at the next turn")
    assert h.store.get_session(sid).capped
    h.store.update_work_item(cap_item(h).id, assignee="lan")
    h._settle(sid)
    assert state(h, sid) == ("waiting", ["lan"])
    h.store.update_work_item(cap_item(h).id, status="done")  # closed some other way: the cost is still over the cap
    h._settle(sid)
    assert state(h, sid) == ("waiting", ["ngocbh"])  # the manager at the pinned commit
    h.set_cost_cap(sid, 20)
    assert state(h, sid) == ("idle", []) and not h.store.get_session(sid).capped


def test_raising_the_cap_of_a_sleeping_session_frees_it_without_a_worker(make_harness, fake_llm, workspace):
    prices = {"stub": Price(input=1_000_000, output=0)}
    first = make_harness(prices=prices)
    fake_llm.script(PRICEY)
    sid = start(first, workspace)
    first.prompt(sid, "hi")
    wait_for(lambda: status(first, sid) == "waiting", what="the hold")
    first.close_all()
    second = make_harness(prices=prices)  # not restored: the session sleeps
    second.set_cost_cap(sid, 20)
    assert state(second, sid) == ("idle", []) and sid not in second._live


def test_a_cap_raise_whose_settle_fails_still_stands(harness, workspace, monkeypatch):
    sid = start(harness, workspace)

    def broken(session_id):
        raise OSError("the pin can't be read")

    monkeypatch.setattr(harness, "_settle", broken)
    assert harness.set_cost_cap(sid, 20).cost_cap_usd == 20  # logged, not a route error


def test_a_session_waiting_at_a_question_node_sleeps_and_an_answer_wakes_it_to_the_node(make_harness, workspace):
    first = make_harness(files=GATE_FILES)
    sid, q = at_the_gate(first, workspace)
    first.close_all()
    second = make_harness()
    second.restore()
    assert sid not in second._live and second.store.get_question(q.id).status == "open"
    assert state(second, sid) == ("waiting", ["ngocbh"])
    second.answer(q.id, GATE_ANSWER, "option", by="ngocbh")
    wait_for(lambda: status(second, sid) == "ended", what="the flow's end")


def test_a_session_waiting_on_ask_user_resumes_at_start_and_asks_again(make_harness, fake_llm, workspace):
    fake_llm.script(ASK_USER, ASK_USER)
    first = make_harness()
    sid = start(first, workspace)
    first.prompt(sid, "hi")
    old = card(first, sid, "ask_user")
    wait_for(lambda: status(first, sid) == "waiting", what="waiting")
    first.close_all()
    second = make_harness()
    second.restore()
    assert sid in second._live
    wait_for(lambda: [q for q in second.store.list_questions(session_id=sid, status="open", source="ask_user")
                      if q.id != old.id], what="asked again")
    assert second.store.get_question(old.id).status == "stale"
    wait_for(lambda: state(second, sid) == ("waiting", ["ngocbh"]), what="waiting again")


def test_end_on_a_session_asleep_at_a_question_node_stays_ending_across_a_restart(make_harness, workspace):
    first = make_harness(files=GATE_FILES)
    sid, q = at_the_gate(first, workspace)
    first.close_all()
    second = make_harness()
    second.restore()
    assert sid not in second._live
    second.end(sid)  # wakes it for the end; the node comes before the exit
    assert state(second, sid) == ("ending", []) and second.store.get_question(q.id).status == "open"
    second.close_all()
    third = make_harness()
    third.restore()
    assert sid in third._live and third._live[sid].ending  # an ending session resumes at every start
    assert status(third, sid) == "ending"
    third.answer(q.id, GATE_ANSWER, "option", by="ngocbh")
    wait_for(lambda: status(third, sid) == "ended", what="the end")


def test_restore_settles_a_sleeping_session_held_at_its_cap(make_harness, workspace):
    first = make_harness()
    sid = start(first, workspace)
    first.close_all()
    first.store.update_session(sid, cost=6)  # over the $5 cap, but stored idle, as an older office left it
    second = make_harness()
    second.restore()
    assert sid not in second._live
    assert state(second, sid) == ("waiting", ["ngocbh"]) and second.store.get_session(sid).capped


def test_esc_answers_an_ask_manager_card_interrupted_and_closes_its_item(harness, fake_llm, workspace):
    fake_llm.script(ASK_MANAGER)
    sid = start(harness, workspace)
    harness.prompt(sid, "hi")
    q = card(harness, sid, "ask_manager")
    wait_for(lambda: state(harness, sid) == ("waiting", ["ngocbh"]), what="waiting on the manager")
    harness.interrupt(sid)
    got = wait_for(lambda: (x := harness.store.get_question(q.id)).status != "open" and x, what="the answer")
    assert got.status in ("answered", "consumed") and (got.answer, got.answer_kind) == (INTERRUPTED, "interrupted")
    # Answered, not stale, so Cards.stored carries none of its discussion into a later card.
    wait_for(lambda: harness.store.get_work_item(q.work_item_id).status == "done", what="the item closed")
    wait_for(lambda: status(harness, sid) != "waiting", what="no longer waiting")

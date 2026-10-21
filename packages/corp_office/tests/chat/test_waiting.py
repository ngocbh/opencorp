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

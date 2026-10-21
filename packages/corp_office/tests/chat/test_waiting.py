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

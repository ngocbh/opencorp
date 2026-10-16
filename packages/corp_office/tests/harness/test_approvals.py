"""Codex requests as cards: store, then reply; first answer wins; stale when Codex no longer waits."""

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

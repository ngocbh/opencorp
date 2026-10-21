"""The run state Codex sessions write, and how a restart finds a waiting one."""

from opencorp.testing import fake_codex as fc
from tests.harness.conftest import start, status, texts, wait_for
from tests.harness.test_approvals import approval_turn, open_card
from tests.harness.test_restore import restarted


def state(h, sid):
    s = h.store.get_session(sid)
    return s.status, s.waiting_on


def statuses(h, sid):
    """The statuses the session was written with, in order, without repeats."""
    seen = [e.data["status"] for e in h.store.events_after() if e.type == "session.updated" and e.subject_id == sid]
    return [x for n, x in enumerate(seen) if n == 0 or seen[n - 1] != x]


def test_an_approval_inside_a_turn_is_waiting_then_busy_after_the_reply(harness, fake_codex, workspace):
    fake_codex.script([approval_turn()])
    sid = start(harness, workspace)
    harness.prompt(sid, "make a")
    q = open_card(harness, sid)
    wait_for(lambda: state(harness, sid) == ("waiting", ["ngocbh"]), what="waiting on the opener")
    harness.answer(q.id, "Approve", "option", by="ngocbh")
    wait_for(lambda: state(harness, sid) == ("idle", []), what="the turn's end")
    assert statuses(harness, sid)[-3:] == ["waiting", "busy", "idle"]


def test_a_turnless_card_is_waiting_with_no_turn_then_idle_once_answered(harness, fake_codex, workspace):
    fake_codex.script([[fc.url_elicitation(8, "gh", "Sign in", "https://e.com/l", wait=False)]])
    sid = start(harness, workspace)
    harness.prompt(sid, "sign in")
    q = open_card(harness, sid)
    wait_for(lambda: state(harness, sid) == ("waiting", ["ngocbh"]) and harness.codex._live[sid].turn_id is None,
             what="waiting after the turn")
    harness.answer(q.id, "Done", "option", by="ngocbh")
    wait_for(lambda: state(harness, sid) == ("idle", []), what="idle, not busy")


def test_a_card_codex_resolves_itself_leaves_waiting(harness, fake_codex, workspace):
    fake_codex.script([[fc.command_approval(1, "c1", "touch a", wait=False), {"sleep": 0.3}, {"resolve": 1},
                        {"sleep": 5}]])
    sid = start(harness, workspace)
    harness.prompt(sid, "make a")
    open_card(harness, sid)
    wait_for(lambda: status(harness, sid) == "waiting", what="waiting")
    wait_for(lambda: state(harness, sid) == ("busy", []), what="busy again once Codex resolved it")


def test_a_waiting_session_with_a_turn_card_restores_idle_with_the_marker(make_codex, fake_codex, workspace):
    fake_codex.script([[fc.command_started("c1", "sleep 60"), fc.command_approval(1, "c1", "sleep 60")]])
    old = make_codex()
    sid = start(old, workspace)
    old.prompt(sid, "go")
    wait_for(lambda: status(old, sid) == "waiting", what="the card")
    h = restarted(make_codex, old)
    assert state(h, sid) == ("idle", []) and texts(h, sid)[-1].endswith("[interrupted]")
    assert [q.status for q in h.store.list_questions(session_id=sid)] == ["stale"]


def test_a_session_waiting_only_on_turnless_cards_restores_idle_without_the_marker(make_codex, fake_codex,
                                                                                  workspace):
    fake_codex.script([[fc.url_elicitation(8, "gh", "Sign in", "https://e.com/l", wait=False)]])
    old = make_codex()
    sid = start(old, workspace)
    old.prompt(sid, "sign in")
    wait_for(lambda: status(old, sid) == "waiting" and old.codex._live[sid].turn_id is None, what="waiting")
    h = restarted(make_codex, old)
    assert state(h, sid) == ("idle", [])
    assert not any(t.endswith("[interrupted]") for t in texts(h, sid))


def test_a_session_waiting_on_a_turnless_card_mid_turn_restores_idle_with_the_marker(make_codex, fake_codex,
                                                                                    workspace):
    fake_codex.script([[fc.url_elicitation(8, "gh", "Sign in", "https://e.com/l", wait=False), {"sleep": 30}]])
    old = make_codex()
    sid = start(old, workspace)
    old.prompt(sid, "sign in")
    wait_for(lambda: status(old, sid) == "waiting" and old.codex._live[sid].turn_id is not None,
             what="waiting inside the turn")
    h = restarted(make_codex, old)
    assert state(h, sid) == ("idle", []) and texts(h, sid) == ["[interrupted]"]
    assert [q.status for q in h.store.list_questions(session_id=sid)] == ["stale"]

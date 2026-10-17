"""After an office restart: idle stays idle, busy becomes idle and interrupted, starting fails, cards go stale."""

import threading

import pytest

from agent_corp.protocol import now
from agent_corp.protocol.models import Message, TextPart, ToolPart
from agent_corp.store import new_id
from agent_corp.testing import fake_codex as fc
from tests.harness.conftest import errors, start, status, texts, wait_for


def restarted(make_codex, old, **patches):
    """A new harness over the same office, as a restarted office builds it, after ``old`` stopped; ``patches`` replace
    attributes of its Codex sessions before the restore."""
    old.close_all()
    h = make_codex()
    for name, value in patches.items():
        setattr(h.codex, name, value)
    h.restore()
    return h


def test_an_idle_session_stays_idle_and_reloads_on_its_next_message(make_codex, fake_codex, workspace):
    fake_codex.script([[fc.command_approval(1, "c1", "x", wait=False), {"end": "completed"}],
                       fc.agent_message("m1", "Resumed")])
    old = make_codex()
    sid = start(old, workspace)
    old.prompt(sid, "go")
    wait_for(lambda: old.store.list_questions(session_id=sid) and status(old, sid) == "idle", what="the turn's end")
    h = restarted(make_codex, old)
    assert status(h, sid) == "idle" and h.store.list_workers() == []
    assert h.prompt(sid, "hello") == "queued"
    wait_for(lambda: "Resumed" in texts(h, sid), what="the reloaded reply")
    assert fake_codex.calls("thread/resume")[0]["threadId"] == "thr_1"
    assert [r.session_id for r in h.store.list_workers()] == [f"harness:{sid}"]


def test_a_restored_idle_session_ends_after_idle_end(make_codex, fake_codex, workspace):
    old = make_codex()
    sid = start(old, workspace)
    h = restarted(make_codex, old, idle_seconds=lambda session_id: 1)
    wait_for(lambda: status(h, sid) == "ended", timeout=10, what="idle_end")
    assert fake_codex.calls("thread/resume") == []  # ending it needed no app-server


def test_a_busy_session_becomes_idle_with_a_marker_and_its_cards_go_stale(make_codex, fake_codex, workspace):
    fake_codex.script([[fc.command_started("c1", "sleep 60"), fc.command_approval(1, "c1", "sleep 60")]])
    old = make_codex()
    sid = start(old, workspace)
    old.prompt(sid, "go")
    wait_for(lambda: old.store.list_questions(session_id=sid, status="open"), what="the card")
    h = restarted(make_codex, old)
    assert status(h, sid) == "idle"
    assert [q.status for q in h.store.list_questions(session_id=sid)] == ["stale"]
    parts = [p for m in h.store.list_messages(sid) for p in m.parts]
    assert any(p.type == "tool" and p.state == "interrupted" for p in parts)
    assert parts[-1].type == "text" and parts[-1].text.endswith("[interrupted]")
    assert sum(p.type == "text" and p.text.endswith("[interrupted]") for p in parts) == 1


def test_a_session_an_office_crash_left_busy_gets_its_tools_and_turn_marked(make_codex, fake_codex, workspace):
    fake_codex.script([[fc.command_started("c1", "sleep 60"), {"sleep": 30}]])
    old = make_codex()
    sid = start(old, workspace)
    old.prompt(sid, "go")
    wait_for(lambda: any(p.type == "tool" for m in old.store.list_messages(sid) for p in m.parts), what="the command")
    # A crashed office stores nothing at its stop: kill the app-server and drop the session as a crash would.
    live = old.codex._live.pop(sid)
    with live._lock:
        live.stopped = True
        process, live.process = live.process, None
    process.kill()
    live._jobs.put(None)
    h = make_codex()
    h.restore()
    parts = [p for m in h.store.list_messages(sid) for p in m.parts]
    assert [p.state for p in parts if p.type == "tool"] == ["interrupted"]
    assert parts[-1].type == "text" and parts[-1].text.endswith("[interrupted]") and status(h, sid) == "idle"


def test_a_session_still_starting_fails(make_codex, fake_codex, workspace):
    old = make_codex()
    sid = start(old, workspace)
    old.store.update_session(sid, status="starting")
    h = restarted(make_codex, old)
    assert status(h, sid) == "failed" and "restarted before Codex started" in errors(h, sid)[0]
    assert sid not in h.codex._live


def test_a_session_ending_when_the_office_stopped_ends(make_codex, fake_codex, workspace):
    old = make_codex()
    sid = start(old, workspace)
    old.store.update_session(sid, status="ending")
    ended = []
    h = make_codex()
    h.hooks.session_ended.append(lambda s: ended.append(s.status))
    old.close_all()
    h.restore()
    assert status(h, sid) == "ended" and ended == ["ended"] and sid not in h.codex._live
    assert h.store.get_work_item(h.store.get_session(sid).work_item_id).status == "done"


def test_a_session_that_cant_be_restored_leaves_the_others_restored(make_codex, fake_codex, workspace, monkeypatch):
    old = make_codex()
    first, second = start(old, workspace), start(old, workspace)
    old.close_all()
    h = make_codex()
    real = h.codex._restore

    def broken(session):
        if session.id == first:
            raise RuntimeError("sentinel")
        real(session)
    monkeypatch.setattr(h.codex, "_restore", broken)
    h.restore()
    assert second in h.codex._live and first not in h.codex._live


def test_office_stop_mid_reply_keeps_all_its_text_and_marks_it_once(make_codex, fake_codex, workspace):
    fake_codex.script([[fc.agent_message("m1", "Hello there, friend")[0], fc.agent_message_delta("m1", "Hello "),
                        fc.agent_message_delta("m1", "there, "), fc.agent_message_delta("m1", "friend"),
                        {"sleep": 30}]])
    old = make_codex()
    sid = start(old, workspace)
    old.prompt(sid, "go", by="ngocbh")
    wait_for(lambda: [e.data["text"] for e in old.office.bus.events if e.type == "part.delta"][-1:] == ["friend"],
             what="the third delta")
    h = restarted(make_codex, old)
    got = [(m.role, [p.text for p in m.parts]) for m in h.store.list_messages(sid)]
    assert got == [("user", ["go"]), ("assistant", ["Hello there, friend\n\n[interrupted]"])]
    assert status(h, sid) == "idle"


def test_a_busy_session_whose_newest_message_is_only_the_marker_keeps_one(make_codex, fake_codex, workspace):
    old = make_codex()
    sid = start(old, workspace)
    old.store.add_message(Message(id=new_id(), session_id=sid, role="assistant", created_at=now(),
                                  parts=[TextPart(id=new_id(), type="text", text="[interrupted]")]))
    old.store.update_session(sid, status="busy")
    h = restarted(make_codex, old)
    assert texts(h, sid) == ["[interrupted]"] and status(h, sid) == "idle"


def test_a_restored_session_whose_first_reload_fails_still_ends_after_idle_end(make_codex, fake_codex, workspace):
    old = make_codex()
    sid = start(old, workspace)
    fake_codex.script(resume_error={"code": -32600, "message": "no rollout found"})
    asked = threading.Event()

    def idle_seconds(session_id):
        asked.wait(5)  # the restore's own read waits until the message's reload is under way
        return 1
    h = restarted(make_codex, old, idle_seconds=idle_seconds)
    assert h.prompt(sid, "hello") == "queued"
    asked.set()
    wait_for(lambda: errors(h, sid), what="the refused reload")
    wait_for(lambda: status(h, sid) == "ended", timeout=10, what="idle_end")


@pytest.mark.parametrize("left", ["starting", "ending", "idle"])
def test_restore_interrupts_tool_parts_left_running_whatever_the_status(make_codex, fake_codex, workspace, left):
    old = make_codex()
    sid = start(old, workspace)
    old.store.add_message(Message(id=new_id(), session_id=sid, role="assistant", created_at=now(), parts=[
        ToolPart(id=new_id(), type="tool", call_id="c1", tool="codex.command", state="running", input={})]))
    old.store.update_session(sid, status=left)
    h = restarted(make_codex, old)
    assert [p.state for m in h.store.list_messages(sid) for p in m.parts if p.type == "tool"] == ["interrupted"]


def test_a_restore_after_office_stop_restores_nothing(make_codex, fake_codex, workspace):
    fake_codex.script([[fc.command_started("c1", "sleep 60"), fc.command_approval(1, "c1", "sleep 60")]])
    old = make_codex()
    sid = start(old, workspace)
    old.prompt(sid, "go")
    wait_for(lambda: old.store.list_questions(session_id=sid, status="open"), what="the card")
    old.close_all()
    h = make_codex()
    h.codex.close_all()
    h.codex.restore()
    assert h.codex._live == {} and status(h, sid) == "busy"
    assert [q.status for q in h.store.list_questions(session_id=sid)] == ["open"]

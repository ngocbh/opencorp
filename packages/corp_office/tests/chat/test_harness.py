import json

import pytest

from agent_corp.chat.harness import HarnessError
from agent_corp.chat.turns import MAIN_CHAT
from tests.chat.conftest import errors, status, texts, wait_for


def start(harness, workspace):
    session = harness.start_session("minh", str(workspace))
    wait_for(lambda: status(harness, session.id) == "idle", what="the first turn")
    return session.id


def test_a_turn_replies_and_end_finishes_the_session(harness, fake_llm, workspace):
    fake_llm.script({"content": "Hello from Minh."})
    sid = start(harness, workspace)
    session = harness.store.get_session(sid)
    assert (session.kind, session.harness, len(session.run_ids)) == ("main", "composer", 1)

    assert harness.prompt(sid, "hi") == "turn"
    wait_for(lambda: texts(harness, sid) == ["Hello from Minh."], what="the reply")
    wait_for(lambda: status(harness, sid) == "idle", what="the next turn")
    assert texts(harness, sid, "user") == ["hi"]

    seen = []  # the work item's status when each session status is stored
    update = harness.store.update_session
    harness.store.update_session = lambda sid_, **kw: (
        seen.append((kw.get("status"), harness.store.get_work_item(session.work_item_id).status)),
        update(sid_, **kw))[1]
    harness.end(sid)
    wait_for(lambda: status(harness, sid) == "ended", what="the end")
    assert ("ended", "done") in seen and ("ended", "in_progress") not in seen
    with pytest.raises(HarnessError) as err:
        harness.prompt(sid, "late")
    assert err.value.code == "not_live"


def asked(fake_llm, n):
    """The messages of the ``n``th model request (from 1), as JSON text."""
    return json.dumps(fake_llm.wait_for_requests(n)[n - 1]["messages"])


def echo_call(text="x"):
    return {"name": "fake__echo", "arguments": {"text": text}}


def test_a_steer_reaches_the_running_reply(harness, fake_llm, workspace):
    fake_llm.script({"content": "Working", "tool_calls": [echo_call()], "hold": 30}, {"content": "Done."})
    sid = start(harness, workspace)
    harness.prompt(sid, "hi")
    fake_llm.wait_for_requests(1)
    assert harness.steer(sid, "Also mention Rome.") == "steer"
    fake_llm.release()
    assert "Also mention Rome." in asked(fake_llm, 2)
    wait_for(lambda: status(harness, sid) == "idle" and texts(harness, sid)[-1:] == ["Done."], what="the reply")
    assert texts(harness, sid, "user") == ["hi", "Also mention Rome."]
    # The steer comes after the text streamed before the model read it, and before the text after.
    assert [(m.role, [p.text for p in m.parts if p.type == "text"]) for m in harness.store.list_messages(sid)] == [
        ("user", ["hi"]), ("assistant", ["Working"]), ("user", ["Also mention Rome."]), ("assistant", ["Done."])]


def test_a_steer_the_reply_never_reads_is_the_next_turn(harness, fake_llm, workspace):
    fake_llm.script({"content": "Done.", "hold": 30}, {"content": "Second."})
    sid = start(harness, workspace)
    harness.prompt(sid, "hi")
    fake_llm.wait_for_requests(1)
    assert harness.steer(sid, "one more thing") == "steer"
    fake_llm.release()
    assert "one more thing" in asked(fake_llm, 2)
    wait_for(lambda: texts(harness, sid) == ["Done.", "Second."], what="the second reply")
    assert texts(harness, sid, "user") == ["hi", "one more thing"]  # written once, when accepted


def test_a_message_answers_the_models_open_question(harness, fake_llm, workspace):
    fake_llm.script({"tool_calls": [{"name": "ask_user", "arguments": {"question": "Which?", "options": ["A", "B"]}}]},
                    {"content": "You chose."})
    sid = start(harness, workspace)
    harness.prompt(sid, "hi")
    q = wait_for(lambda: harness.store.list_questions(session_id=sid, status="open", source="ask_user"),
                 what="the model's question")[0]
    assert status(harness, sid) == "busy"
    assert harness.prompt(sid, "Option B, please") == "answer"
    assert "Option B, please" in asked(fake_llm, 2)
    wait_for(lambda: texts(harness, sid)[-1:] == ["You chose."], what="the reply")
    assert harness.store.get_question(q.id).status == "consumed"


def test_a_message_that_loses_the_question_to_a_card_answer_is_the_next_message(harness, fake_llm, workspace):
    fake_llm.script({"tool_calls": [{"name": "ask_user", "arguments": {"question": "Which?", "options": ["A", "B"]}}]},
                    {"content": "You chose."}, {"content": "Noted."})
    sid = start(harness, workspace)
    harness.prompt(sid, "hi")
    q = wait_for(lambda: harness.store.list_questions(session_id=sid, status="open", source="ask_user"),
                 what="the model's question")[0]
    answer = harness.store.answer_question

    def card_first(question_id, *args, **kwargs):
        # The card's answer lands between the message's look-up and its own answer.
        harness.store.answer_question = answer
        answer(question_id, "A", "option", answered_by="ceo")
        return answer(question_id, *args, **kwargs)

    harness.store.answer_question = card_first
    assert harness.prompt(sid, "B, and keep it short") in ("steer", "queued")
    assert harness.store.get_question(q.id).answer == "A"
    wait_for(lambda: "B, and keep it short" in json.dumps(fake_llm.requests()), what="the message reaching the model")
    wait_for(lambda: status(harness, sid) == "idle", what="the next turn")
    assert texts(harness, sid, "user") == ["hi", "B, and keep it short"]


def test_esc_answers_the_models_question_and_keeps_the_run(harness, fake_llm, workspace):
    fake_llm.script({"tool_calls": [{"name": "ask_user", "arguments": {"question": "Which?"}}]},
                    {"content": "Next."})
    sid = start(harness, workspace)
    harness.prompt(sid, "first-turn-text")
    q = wait_for(lambda: harness.store.list_questions(session_id=sid, status="open", source="ask_user"),
                 what="the model's question")[0]
    harness.interrupt(sid)
    assert harness.store.get_question(q.id).answer_kind == "interrupted"
    wait_for(lambda: status(harness, sid) == "idle", what="the next turn")
    harness.prompt(sid, "again")
    wait_for(lambda: texts(harness, sid)[-1:] == ["Next."], what="the next reply")
    assert len(harness.store.get_session(sid).run_ids) == 1
    assert len(fake_llm.requests()) == 2  # the interrupted reply made no more model calls
    assert "first-turn-text" in asked(fake_llm, 2)  # session memory kept the interrupted turn


def test_a_failed_run_says_so_and_starts_a_new_run(harness, fake_llm, workspace):
    fake_llm.script({"error": 500}, {"content": "Back."})
    sid = start(harness, workspace)
    harness.prompt(sid, "hi")
    wait_for(lambda: len(harness.store.get_session(sid).run_ids) == 2 and status(harness, sid) == "idle",
             what="the new run")
    (error,) = errors(harness, sid)
    assert error.startswith("The reply failed (") and error.endswith("Send your message again.")
    assert texts(harness, sid) == []
    harness.prompt(sid, "again")
    wait_for(lambda: texts(harness, sid)[-1:] == ["Back."], what="the reply")


def test_max_turns_ends_the_session(make_harness, fake_llm, workspace):
    harness = make_harness(defaults={"max_turns": 2})
    fake_llm.script({"content": "one"}, {"content": "two"})
    sid = start(harness, workspace)
    harness.prompt(sid, "a")
    wait_for(lambda: texts(harness, sid) == ["one"] and status(harness, sid) == "idle", what="turn one")
    harness.prompt(sid, "b")
    wait_for(lambda: status(harness, sid) == "ended", what="the end")


def test_an_idle_session_ends(make_harness, fake_llm, workspace):
    harness = make_harness(defaults={"idle_end": "1s"})
    session = harness.start_session("minh", str(workspace))
    wait_for(lambda: status(harness, session.id) == "ended", timeout=15, what="the idle end")


def test_end_while_busy_interrupts_then_exits(harness, fake_llm, workspace):
    fake_llm.script({"content": "Working", "tool_calls": [echo_call()], "hold": 30}, {"content": "never"})
    sid = start(harness, workspace)
    harness.prompt(sid, "hi")
    fake_llm.wait_for_requests(1)
    harness.end(sid)
    assert status(harness, sid) == "ending"
    with pytest.raises(HarnessError) as err:
        harness.prompt(sid, "more")
    assert (err.value.status, err.value.code) == (409, "ending")
    fake_llm.release()
    wait_for(lambda: status(harness, sid) == "ended", what="the end")
    assert len(fake_llm.requests()) == 1


def test_esc_before_the_reply_starts_still_stops_it(harness, fake_llm, workspace, monkeypatch):
    import threading

    from agent_corp.chat import harness as harness_module

    fake_llm.script({"content": "Working", "tool_calls": [echo_call()], "hold": 30}, {"content": "never"})
    seen, release = threading.Event(), threading.Event()
    event = harness_module._Handlers.event

    def slow_start(self, worker, frame):
        if frame["name"] == "NodeStarted" and MAIN_CHAT.is_reply(frame["data"].get("node_id")):
            seen.set()
            release.wait(30)  # the harness hasn't seen the reply start when Esc comes
        return event(self, worker, frame)

    monkeypatch.setattr(harness_module._Handlers, "event", slow_start)
    sid = start(harness, workspace)
    harness.prompt(sid, "hi")
    assert seen.wait(15)
    assert harness._live[sid].reply_node is None
    harness.interrupt(sid)
    release.set()

    def stopped():
        fake_llm.release()  # the reply may or may not have made its first call when Esc reached it
        return status(harness, sid) == "idle"

    wait_for(stopped, what="the stopped reply")
    assert len(fake_llm.requests()) <= 1


def test_a_failed_reply_is_no_longer_the_running_reply(harness, workspace):
    sid = start(harness, workspace)
    live = harness._live[sid]
    harness._event(live, live.worker, "NodeStarted", {"node_id": "chat#0/reply"})
    assert live.reply_node == "chat#0/reply"
    harness._event(live, live.worker, "NodeFailed", {"failure": {"node_id": "chat#0/reply", "message": "boom"}})
    assert live.reply_node is None


def test_a_turn_answer_that_fails_leaves_the_turn_open(harness, fake_llm, workspace, monkeypatch):
    fake_llm.script({"content": "Hello."})
    sid = start(harness, workspace)
    answer_question, failed = harness.store.answer_question, []

    def flaky(*args, **kwargs):
        if not failed:
            failed.append(True)
            raise RuntimeError("disk full")
        return answer_question(*args, **kwargs)

    monkeypatch.setattr(harness.store, "answer_question", flaky)
    with pytest.raises(RuntimeError):
        harness.prompt(sid, "hi")
    live = harness._live[sid]
    assert live.turn_q is not None  # the next message still takes the turn
    assert harness.prompt(sid, "are you there") == "turn"
    wait_for(lambda: texts(harness, sid)[-1:] == ["Hello."], what="the reply")
    assert "are you there" in asked(fake_llm, 1)


def test_turns_are_answered_for_the_ceo_of_the_pinned_company(harness, fake_llm, workspace, monkeypatch):
    from agent_corp.chat import harness as harness_module

    fake_llm.script({"content": "Hello."})
    sid = start(harness, workspace)
    ceo = harness._live[sid].owner
    assert ceo

    def no_repo(*args, **kwargs):
        raise AssertionError("the company repo was re-read")

    monkeypatch.setattr(harness_module, "load_repo", no_repo)
    harness.prompt(sid, "hi")
    wait_for(lambda: texts(harness, sid)[-1:] == ["Hello."], what="the reply")
    (turn,) = [q for q in harness.store.list_questions(session_id=sid) if q.answer == "hi"]
    assert turn.answered_by == ceo


def test_hooks_see_the_session(harness, fake_llm, workspace):
    seen = []
    harness.hooks.run_started.append(lambda s, run_id: seen.append(("run_started", run_id)))
    harness.hooks.question_stored.append(lambda q: seen.append(("question_stored", q.source)))
    harness.hooks.run_finished.append(lambda s, run_id, result: seen.append(("run_finished", result["status"])))
    harness.hooks.session_ended.append(lambda s: seen.append(("session_ended", s.status)))
    harness.hooks.answer_check.append(lambda q, answer, kind: "no swearing" if answer == "darn" else None)
    fake_llm.script({"content": "ok"})
    sid = start(harness, workspace)
    turn = harness.store.list_questions(session_id=sid, status="open")[0]
    with pytest.raises(HarnessError) as err:
        harness.answer(turn.id, "darn", "text")
    assert (err.value.code, err.value.message) == ("invalid_answer", "no swearing")
    harness.answer(turn.id, "hello", "text")
    wait_for(lambda: texts(harness, sid) == ["ok"] and status(harness, sid) == "idle", what="the reply")
    harness.end(sid)
    wait_for(lambda: ("session_ended", "ended") in seen, what="session_ended")
    run_id = harness.store.get_session(sid).run_ids[0]
    assert seen[0] == ("run_started", run_id)
    assert seen[-2:] == [("run_finished", "succeeded"), ("session_ended", "ended")]
    assert ("question_stored", "human_input") in seen


def test_a_session_records_the_resolved_folder(harness, fake_llm, tmp_path, workspace):
    link = tmp_path / "link"
    link.symlink_to(workspace)
    session = harness.start_session("minh", str(link))
    real = str(workspace.resolve())
    assert session.cwd == real
    assert [f.cwd for f in harness.store.worked_folders("minh")] == [real]


@pytest.mark.parametrize("person, cwd, code", [
    ("nobody", None, "not_found"), ("ngocbh", None, "not_an_agent"),
    ("minh", "relative/path", "invalid_body"), ("minh", "/", "unsafe_workspace"),
])
def test_start_refuses_bad_requests(harness, workspace, person, cwd, code):
    with pytest.raises(HarnessError) as err:
        harness.start_session(person, cwd or str(workspace))
    assert err.value.code == code
    assert harness.store.list_sessions() == []
    assert not harness.office.paths.runs.exists()  # refused before the run's tmp is made


@pytest.mark.parametrize("where", ["", "company", "office", "office/runs"])  # "" is the home
def test_start_refuses_the_offices_own_folders(harness, where):
    paths = harness.office.paths
    cwd = paths.home / where
    cwd.mkdir(parents=True, exist_ok=True)
    with pytest.raises(HarnessError) as err:
        harness.start_session("minh", str(cwd))
    assert (err.value.status, err.value.code) == (422, "unsafe_workspace")
    assert harness.store.list_sessions() == []
    assert not paths.runs.exists() or not any(paths.runs.iterdir())


def test_esc_racing_the_end_of_a_reply_leaves_the_next_turn_open(harness, fake_llm, workspace):
    fake_llm.script({"content": "Done.", "hold": True}, {"content": "Next."})
    sid = start(harness, workspace)
    harness.prompt(sid, "hi")
    fake_llm.wait_for_requests(1)
    fake_llm.release()
    for _ in range(20):  # Esc again and again as the reply ends and the next turn opens
        harness.interrupt(sid)
    wait_for(lambda: status(harness, sid) == "idle", what="the next turn")
    harness.interrupt(sid)
    turns = harness.store.list_questions(session_id=sid, source="human_input")
    assert [q.status for q in turns] == ["consumed", "open"]
    assert harness.prompt(sid, "again") == "turn"
    wait_for(lambda: texts(harness, sid)[-1:] == ["Next."], what="the next reply")


def test_a_failing_hook_does_not_stop_the_session(harness, fake_llm, workspace):
    def broken(*args):
        raise RuntimeError("boom")

    for name in ("question_stored", "run_started", "run_finished", "session_ended"):
        getattr(harness.hooks, name).append(broken)
    fake_llm.script({"content": "ok"})
    sid = start(harness, workspace)
    harness.prompt(sid, "hi")
    wait_for(lambda: texts(harness, sid) == ["ok"] and status(harness, sid) == "idle", what="the reply")
    harness.end(sid)
    wait_for(lambda: status(harness, sid) == "ended", what="the end")


def test_a_provider_error_at_start_fails_the_session(harness, workspace):
    from agent_corp.chat.provider import ProviderError

    def bad():
        raise ProviderError("provider.json must be a regular file private to its owner (mode 0600)")

    harness.provider = bad
    ended = []
    harness.hooks.session_ended.append(lambda session: ended.append(session.status))
    with pytest.raises(HarnessError) as err:
        harness.start_session("minh", str(workspace))
    (session,) = harness.store.list_sessions()
    assert (err.value.status, err.value.code) == (500, "start_failed")
    assert err.value.message == (f"session {session.id} failed to start: provider.json must be a regular file "
                                 "private to its owner (mode 0600)")
    assert isinstance(err.value.__cause__, ProviderError)
    assert session.status == "failed" and session.id not in harness._live
    assert ended == ["failed"]
    with pytest.raises(HarnessError) as err:
        harness.prompt(session.id, "hi")
    assert err.value.code == "not_live"


def test_a_run_that_cant_be_set_up_fails_the_session_and_says_so(harness, workspace, monkeypatch):
    def no_run(*args):
        raise OSError("disk full")

    ended = []
    harness.hooks.session_ended.append(lambda session: ended.append(session.status))
    monkeypatch.setattr(harness.store, "add_session_run", no_run)
    with pytest.raises(HarnessError) as err:
        harness.start_session("minh", str(workspace))
    assert err.value.code == "start_failed" and isinstance(err.value.__cause__, OSError)
    assert [s.status for s in harness.store.list_sessions()] == ended == ["failed"]


def test_nothing_the_harness_does_touches_the_store_after_close_all(harness, workspace):
    sid = start(harness, workspace)
    live = harness._live[sid]
    exited = []
    harness.hooks.worker_exited.append(lambda session, code: exited.append(code))
    worker = live.worker
    harness.close_all()
    assert harness._closed  # the caller may close the store now
    exited.clear()
    ran = []
    harness._jobs.put((ran.append, ("late job",)))
    harness._jobs.put(None)
    harness._dispatch()  # a dispatcher that outlived close_all
    harness._exited(live, worker, 0)
    assert ran == [] and exited == []


def test_close_all_refuses_and_cancels_worker_requests_only_once_the_channels_are_closed(harness, workspace):
    from agent_corp.chat.harness import _Call

    sid = start(harness, workspace)
    call = _Call()
    harness._live[sid].calls.add(call)
    seen = []
    close = harness.registry.close_all

    def closing(*args, **kwargs):
        with harness._in_call():  # a request arriving before its worker's channel closes
            seen.append(("admitted", call.cancelled, harness._stopping))  # _stopping: no new spawn
        close(*args, **kwargs)

    harness.registry.close_all = closing
    harness.close_all()
    assert seen == [("admitted", False, True)]
    assert call.cancelled
    with pytest.raises(RuntimeError, match="stopping"):
        with harness._in_call():
            pass


def test_a_stopping_harness_refuses_new_worker_requests(harness):
    harness.close_all()
    with pytest.raises(RuntimeError, match="stopping"):
        with harness._in_call():
            pass


def test_esc_answers_an_office_call_in_flight(make_harness, fake_llm, workspace):
    import threading

    from agent_corp.assets import fake
    from agent_corp.assets.registry import KindTool
    from agent_corp.chat.harness import INTERRUPTED_CALL
    from agent_corp.chat.transcript import INTERRUPTED_TEXT

    entered, leave = threading.Event(), threading.Event()

    def slow(asset, args, secrets):
        entered.set()
        leave.wait(30)
        return "late"

    harness = make_harness(kinds={"fake": {"echo": KindTool(slow, parameters=fake.TOOLS["echo"].parameters)}})
    fake_llm.script({"content": "Working", "tool_calls": [echo_call()]}, {"content": "Next."})
    sid = start(harness, workspace)
    harness.prompt(sid, "go")
    assert entered.wait(30)
    harness.interrupt(sid)
    wait_for(lambda: status(harness, sid) == "idle", what="the next turn")
    tools = [p for m in harness.store.list_messages(sid) for p in m.parts if p.type == "tool"]
    assert [(t.tool, t.state, t.output) for t in tools] == [("fake__echo", "completed", INTERRUPTED_CALL)]
    *_, reply = harness.store.list_messages(sid)
    assert [p.text if p.type == "text" else p.tool for p in reply.parts] == [
        "Working", "fake__echo", INTERRUPTED_TEXT.lstrip()]  # the stopped reply says so, after the call
    assert len(fake_llm.requests()) == 1  # the reply stopped after the call
    leave.set()


def test_ask_manager_opens_a_work_item_and_waits_for_the_answer(harness, fake_llm, workspace):
    fake_llm.script({"tool_calls": [{"name": "ask_manager", "arguments": {"question": "Budget?"}}]},
                    {"content": "Thanks."})
    sid = start(harness, workspace)
    harness.prompt(sid, "hi")
    q = wait_for(lambda: harness.store.list_questions(session_id=sid, status="open", source="ask_manager"),
                 what="the manager question")[0]
    assert harness.store.get_work_item(q.work_item_id).assignee == "ngocbh"
    harness.answer(q.id, "Yes", "text")
    wait_for(lambda: texts(harness, sid)[-1:] == ["Thanks."], what="the reply")
    assert harness.store.get_work_item(q.work_item_id).status == "done"


def settle(harness):
    """Wait until the harness has handled everything posted so far."""
    import threading

    done = threading.Event()
    harness._post(done.set)
    assert done.wait(30)


def cap_items(harness):
    return sorted((w for w in harness.store.list_work_items() if w.title.startswith("Raise the cost cap")),
                  key=lambda w: (w.created_at, w.id))


def test_the_cost_cap_holds_turns_until_raised(make_harness, fake_llm, workspace):
    from agent_corp.chat.provider import Price

    harness = make_harness(prices={"stub": Price(input=1_000_000, output=0)})  # $1 per input token
    fake_llm.script({"content": "pricey", "usage": {"prompt_tokens": 6, "completion_tokens": 1}},
                    {"content": "after the raise"})
    sid = start(harness, workspace)
    harness.prompt(sid, "hi")
    wait_for(lambda: status(harness, sid) == "idle" and harness.store.get_session(sid).cost == 6, what="the charge")
    items = wait_for(lambda: cap_items(harness), what="the cap work item")
    assert items[0].assignee == "ngocbh"
    assert harness.prompt(sid, "held") == "queued"
    with pytest.raises(HarnessError) as err:
        harness.set_cost_cap(sid, 6)
    assert err.value.code == "cap_too_low"
    harness.set_cost_cap(sid, 20)
    assert "held" in asked(fake_llm, 2)
    wait_for(lambda: texts(harness, sid)[-1:] == ["after the raise"], what="the held turn")


def test_raising_the_cap_closes_its_work_item_and_going_over_again_opens_one(make_harness, fake_llm, workspace):
    from agent_corp.chat.provider import Price

    harness = make_harness(prices={"stub": Price(input=1_000_000, output=0)})  # $1 per input token
    fake_llm.script(*({"content": f"reply {n}", "usage": {"prompt_tokens": 6, "completion_tokens": 1}}
                      for n in range(3)))
    sid = start(harness, workspace)
    parent = harness.store.get_session(sid).work_item_id
    for n, cap in enumerate((None, 7, 13)):
        if cap is None:
            harness.prompt(sid, "hi")
        else:
            assert harness.prompt(sid, f"more {n}") == "queued"  # held at the cap
            harness.set_cost_cap(sid, cap)
            assert [w.status for w in cap_items(harness)] == ["done"] * n  # raising it closes the item
        wait_for(lambda: harness.store.get_session(sid).cost == 6 * (n + 1) and status(harness, sid) == "idle",
                 what=f"charge {n}")
        settle(harness)
        if n < 2:  # over again: one open item, however often the cap check runs
            harness._post(harness._over_cap, harness._live[sid])
            settle(harness)
            assert [w.status for w in cap_items(harness)] == ["done"] * n + ["open"]
    items = cap_items(harness)
    assert [w.status for w in items] == ["done", "done", "open"]
    assert {w.parent_id for w in items} == {parent}


def test_a_cap_item_belongs_to_one_session_even_without_a_work_item(make_harness, workspace):
    from agent_corp.protocol import now
    from agent_corp.protocol.models import WorkItem
    from agent_corp.store import new_id

    harness = make_harness()
    sid = start(harness, workspace)
    t = now()
    harness.store.create_work_item(WorkItem(
        id=new_id(), title="Raise the cost cap of @someone's session", kind="task", status="open",
        requester="p-x", parent_id=None, summary="Session s-other reached its cap.", created_at=t, updated_at=t))
    session = harness.store.get_session(sid).model_copy(update={"work_item_id": None})
    assert harness._cap_item(session) is None


SENTINEL = "sk-sentinel-7c2a51"


def keyed(make_harness):
    from agent_corp.testing.fake_llm import LLM_CONFIG

    return make_harness(llm_config={**LLM_CONFIG, "api_key": SENTINEL})


def test_the_model_key_goes_to_the_job_llm_config_not_its_env(make_harness, workspace):
    harness = keyed(make_harness)
    jobs = []
    spawn = harness.registry.spawn
    harness.registry.spawn = lambda job, *args: (jobs.append(job), spawn(job, *args))[1]
    sid = start(harness, workspace)
    (job,) = jobs
    assert job.llm_config["api_key"] == SENTINEL
    assert SENTINEL not in json.dumps(job.env)
    assert SENTINEL not in repr(harness.store.get_session(sid))


def test_run_finished_hooks_never_see_the_model_key(make_harness, workspace):
    harness = keyed(make_harness)
    seen = []
    harness.hooks.run_finished.append(lambda session, run_id, result: seen.append(result))
    sid = start(harness, workspace)
    live = harness._live[sid]
    harness._finish(live, "failed", {"type": "result", "status": "failed", "output": None, "failure": {
        "node_id": "chat#0/reply", "message": f"1 validation error: api_key Input: '{SENTINEL}'",
        "details": [{"input": {"api_key": SENTINEL}}, SENTINEL]}})
    assert SENTINEL not in json.dumps(seen)
    assert seen[0]["failure"]["message"] == "1 validation error: api_key Input: '[redacted]'"
    assert seen[0]["failure"]["details"] == [{"input": {"api_key": "[redacted]"}}, "[redacted]"]


def test_the_model_key_appears_in_no_frame_event_or_office_file(make_harness, fake_llm, workspace, tmp_path,
                                                               monkeypatch):
    import re

    from agent_corp.chat import harness as harness_module

    frames = []
    for name in ("event", "stream", "result", "error"):
        original = getattr(harness_module._Handlers, name)

        def record(self, worker, frame, original=original):
            frames.append(frame)
            return original(self, worker, frame)

        monkeypatch.setattr(harness_module._Handlers, name, record)
    harness = keyed(make_harness)
    finished = []
    harness.hooks.run_finished.append(lambda session, run_id, result: finished.append(result))
    fake_llm.script({"content": "ok"})
    sid = start(harness, workspace)
    harness.prompt(sid, "hi")
    # The next turn, not just the text: the text part is stored at its first chunk, before it ends.
    wait_for(lambda: (texts(harness, sid) == ["ok"] and status(harness, sid) == "idle")
             or len(harness.store.get_session(sid).run_ids) > 1 or status(harness, sid) == "failed",
             what="the next turn or a failed run")
    harness.close_all()

    def has_key(value):
        return SENTINEL in json.dumps(value, default=str)

    ulid = re.compile(r"[0-9A-HJKMNP-TV-Z]{26}")
    leaks = {("frame", f["type"], f.get("name")) for f in frames if has_key(f)}
    leaks |= {("live", e.type) for e in harness.office.bus.events if SENTINEL in e.model_dump_json()}
    leaks |= {("file", ulid.sub("<id>", str(p.relative_to(tmp_path)))) for p in tmp_path.rglob("*")
              if p.is_file() and SENTINEL.encode() in p.read_bytes()}
    leaks |= {("hook", "run_finished") for result in finished if has_key(result)}
    leaks |= {("model request",) for request in fake_llm.requests() if has_key(request)}
    assert sorted(leaks, key=str) == []
    assert texts(harness, sid) == ["ok"]


def test_a_held_session_with_a_queued_message_does_not_idle_end(make_harness, fake_llm, workspace):
    import time

    from agent_corp.chat.provider import Price

    harness = make_harness(prices={"stub": Price(input=1_000_000, output=0)}, defaults={"idle_end": "1s"})
    fake_llm.script({"content": "pricey", "usage": {"prompt_tokens": 6, "completion_tokens": 1}},
                    {"content": "after the raise"})
    sid = start(harness, workspace)
    harness.prompt(sid, "hi")
    wait_for(lambda: status(harness, sid) == "idle" and harness.store.get_session(sid).cost == 6, what="the charge")
    assert harness.prompt(sid, "please continue") == "queued"
    time.sleep(2.5)
    settle(harness)
    assert status(harness, sid) == "idle"
    harness.set_cost_cap(sid, 20)
    wait_for(lambda: texts(harness, sid)[-1:] == ["after the raise"], what="the held turn")


def test_a_turn_that_opens_held_with_messages_queued_does_not_idle_end(make_harness, fake_llm, workspace):
    import time

    from agent_corp.chat.provider import Price

    harness = make_harness(prices={"stub": Price(input=1_000_000, output=0)}, defaults={"idle_end": "1s"})
    fake_llm.script({"content": "pricey", "usage": {"prompt_tokens": 6, "completion_tokens": 1}, "hold": 30},
                    {"content": "after the raise"})
    sid = start(harness, workspace)
    harness.prompt(sid, "hi")
    fake_llm.wait_for_requests(1)
    harness._live[sid].worker.steer = lambda node, text: False  # the reply can't take it: it waits for the next turn
    assert harness.prompt(sid, "more") == "queued"
    fake_llm.release()
    wait_for(lambda: status(harness, sid) == "idle" and harness.store.get_session(sid).cost == 6, what="the charge")
    time.sleep(2.5)
    settle(harness)
    assert status(harness, sid) == "idle"
    assert harness._live[sid].pending == ["more"]
    harness.set_cost_cap(sid, 20)
    wait_for(lambda: texts(harness, sid)[-1:] == ["after the raise"], what="the held turn")
    assert "more" in asked(fake_llm, 2)


def test_an_end_status_hook_picks_the_status_of_a_normal_end(harness, fake_llm, workspace):
    ended = []
    harness.hooks.end_status += [lambda s: None, lambda s: "debriefing" if s.kind == "main" else None,
                                 lambda s: "ignored"]
    harness.hooks.session_ended.append(lambda s: ended.append(s.status))
    fake_llm.script({"content": "ok"})
    sid = start(harness, workspace)
    harness.end(sid)
    wait_for(lambda: ended, what="session_ended")
    session = harness.store.get_session(sid)
    assert ended == ["debriefing"] and session.status == "debriefing"
    assert harness.store.get_work_item(session.work_item_id).status == "done"


def test_a_prompt_check_refuses_a_message_before_it_reaches_the_session(harness, fake_llm, workspace):
    harness.hooks.prompt_check.append(lambda s, text: "use /back" if text == "/exit" else None)
    fake_llm.script({"content": "ok"})
    sid = start(harness, workspace)
    turn = harness.store.list_questions(session_id=sid, status="open")[0]
    for call in (lambda: harness.prompt(sid, "/exit"), lambda: harness.steer(sid, "/exit"),
                 lambda: harness.answer(turn.id, "/exit", "text")):
        with pytest.raises(HarnessError) as err:
            call()
        assert (err.value.status, err.value.code, err.value.message) == (422, "refused", "use /back")
    assert harness.store.get_question(turn.id).status == "open" and texts(harness, sid, "user") == []
    assert harness.prompt(sid, "hi") == "turn"
    wait_for(lambda: texts(harness, sid) == ["ok"], what="the reply")


def test_turn_text_changes_what_the_turn_gets_but_not_the_transcript(harness, fake_llm, workspace):
    seen = []

    def turn_text(session, question, text):
        seen.append((session.id, question.node_id, text))
        return f"[context]\n\n{text}" if len(seen) == 1 else None

    harness.hooks.turn_text.append(turn_text)
    fake_llm.script({"content": "one"}, {"content": "two"})
    sid = start(harness, workspace)
    harness.prompt(sid, "hi")
    wait_for(lambda: texts(harness, sid) == ["one"] and status(harness, sid) == "idle", what="the first reply")
    harness.prompt(sid, "again")
    wait_for(lambda: texts(harness, sid) == ["one", "two"], what="the second reply")
    assert "[context]\\n\\nhi" in asked(fake_llm, 1) and "[context]" not in json.dumps(
        fake_llm.wait_for_requests(2)[1]["messages"][-1])
    assert texts(harness, sid, "user") == ["hi", "again"]
    assert [(s, text) for s, _, text in seen] == [(sid, "hi"), (sid, "again")]
    harness.end(sid)  # the exit command is the office's, not the person's: no turn_text
    wait_for(lambda: status(harness, sid) == "ended", what="the end")
    assert len(seen) == 2


def test_turn_text_takes_only_a_str_and_skips_the_exit_command(harness, fake_llm, workspace):
    seen = []
    harness.hooks.turn_text += [lambda s, q, text: seen.append(text) or 42, lambda s, q, text: f"<{text}>"]
    fake_llm.script({"content": "one"})
    sid = start(harness, workspace)
    harness.prompt(sid, "hi")
    wait_for(lambda: texts(harness, sid) == ["one"] and status(harness, sid) == "idle", what="the reply")
    assert "<hi>" in asked(fake_llm, 1)  # 42 isn't text, so the next result wins
    assert harness.prompt(sid, MAIN_CHAT.exit) == "turn"  # the person typed the exit command
    wait_for(lambda: status(harness, sid) == "ended", what="the end")
    assert seen == ["hi"]


def test_a_start_that_fails_otherwise_names_the_session_but_not_the_error(harness, workspace, monkeypatch):
    def broken(*args):
        raise RuntimeError("sentinel detail")
    monkeypatch.setattr(harness.registry, "spawn", broken)
    with pytest.raises(HarnessError) as err:
        harness.start_session("minh", str(workspace))
    (session,) = harness.store.list_sessions()
    assert (err.value.status, err.value.code, session.status) == (500, "start_failed", "failed")
    assert session.id in err.value.message and "sentinel" not in err.value.message


def test_a_turn_after_the_provider_changes_runs_on_the_new_provider(harness, fake_llm, workspace):
    fake_llm.script({"content": "One."}, {"content": "Two."})
    sid = start(harness, workspace)
    harness.prompt(sid, "first")
    wait_for(lambda: texts(harness, sid) == ["One."] and status(harness, sid) == "idle", what="the first reply")
    jobs = []
    spawn = harness.registry.spawn
    harness.registry.spawn = lambda job, *args: (jobs.append(job), spawn(job, *args))[1]
    old = harness.provider()
    new = old.model_copy(update={"llm_config": {**old.llm_config, "api_key": "sk-new"}})
    harness.provider = lambda: new

    assert harness.prompt(sid, "second") == "turn"
    wait_for(lambda: texts(harness, sid) == ["One.", "Two."] and status(harness, sid) == "idle",
             what="the reply on the new provider")
    (job,) = jobs
    assert (job.kind, job.llm_config["api_key"]) == ("chat", "sk-new")
    assert len(harness.store.get_session(sid).run_ids) == 2
    assert texts(harness, sid, role="user") == ["first", "second"]


def test_ending_while_a_new_provider_takes_over_ends_the_session(harness, fake_llm, workspace):
    sid = start(harness, workspace)
    old = harness.provider()
    new = old.model_copy(update={"llm_config": {**old.llm_config, "api_key": "sk-new"}})
    harness.provider = lambda: new
    assert harness.prompt(sid, "hi") == "turn"
    harness.end(sid)
    wait_for(lambda: status(harness, sid) == "ended", what="the end")


def test_a_failed_session_says_why_without_the_model_key(make_harness, workspace):
    harness = keyed(make_harness)
    sid = start(harness, workspace)
    harness._finish(harness._live[sid], "failed", {"type": "result", "status": "failed", "output": None, "failure": {
        "node_id": "chat#0/reply", "cause_type": "AuthError", "message": f"bad key {SENTINEL} " + "x" * 900}})
    (error,) = errors(harness, sid)
    assert error.startswith("The session failed (AuthError: bad key [redacted] xxx")
    assert SENTINEL not in error and len(error) < 600
    assert error.endswith("Start a new chat.")


def test_a_session_whose_worker_keeps_dying_says_so(harness, workspace):
    sid = start(harness, workspace)
    harness._finish(harness._live[sid], "failed", None)
    assert errors(harness, sid) == ["The session failed (its worker stopped or couldn't start; see the office log). Start a new chat."]

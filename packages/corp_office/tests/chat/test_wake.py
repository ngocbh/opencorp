"""Waking a sleeping session: one wake at a time, nothing lost, failures leave it as it was."""

import os
import shutil
import signal
import threading
import time

import pytest

from opencorp.chat.harness import HarnessError
from opencorp.chat.turns import MAIN_CHAT
from opencorp.testing.fake_llm import LLM_CONFIG
from tests.chat.conftest import say, spawned, status, texts, wait_for


def start(harness, workspace):
    sid = harness.start_session("minh", str(workspace)).id
    wait_for(lambda: status(harness, sid) == "idle", what="the first turn")
    return sid


def asleep(make_harness, workspace, **office):
    """A session an office left idle when it stopped, and a new office that has no live run for it: asleep."""
    first = make_harness(**office)
    sid = start(first, workspace)
    first.close_all()
    second = make_harness(**office)
    assert sid not in second._live and status(second, sid) == "idle"
    return second, sid


def hold_builds(harness):
    """Hold each wake's build (its run spec) until ``release`` is set; ``entered`` is set when one starts."""
    entered, release, build = threading.Event(), threading.Event(), harness.restorers["main"]

    def held(session):
        entered.set()
        assert release.wait(10)
        return build(session)

    harness.restorers["main"] = held
    return entered, release


def calling(fn, *args):
    """Run ``fn(*args)`` on a thread; returns the thread and a list that gets its result or HarnessError code."""
    out = []

    def run():
        try:
            out.append(fn(*args))
        except HarnessError as exc:
            out.append((exc.status, exc.code))

    thread = threading.Thread(target=run)
    thread.start()
    return thread, out


def test_a_waking_run_that_cant_start_is_dropped_and_its_session_kept(harness, workspace):
    sid = start(harness, workspace)
    live = harness._live[sid]
    live.waking = True
    try:
        raise OSError("can't start the worker")
    except OSError:
        harness._cant_start(live)
    assert sid not in harness._live and status(harness, sid) == "idle"


def test_a_call_after_close_all_is_refused_as_the_office_stopping(harness):
    from opencorp.chat.harness import _Refused

    harness.close_all()
    with pytest.raises(_Refused):
        with harness._in_call():
            pass


def test_a_prompt_wakes_a_sleeping_session_on_its_own_run(make_harness, fake_llm, workspace):
    fake_llm.script({"content": "one"}, {"content": "two"})
    first = make_harness()
    sid = start(first, workspace)
    say(first, sid, "a")
    first.close_all()
    second = make_harness()
    jobs = spawned(second, lambda job: job.kind)
    assert sid not in second._live
    assert say(second, sid, "b") == "two"
    assert jobs == ["resume"] and len(second.store.get_session(sid).run_ids) == 1
    assert "one" in str(fake_llm.requests()[-1]["messages"])  # the resumed run kept the conversation


def test_two_prompts_to_a_sleeping_session_spawn_one_worker_and_both_arrive(make_harness, fake_llm, workspace):
    fake_llm.script({"content": "r1"}, {"content": "r2"})
    h, sid = asleep(make_harness, workspace)
    jobs = spawned(h, lambda job: job.kind)
    entered, release = hold_builds(h)
    a, _ = calling(h.prompt, sid, "first")
    assert entered.wait(10)
    b, _ = calling(h.prompt, sid, "second")
    time.sleep(0.2)
    assert a.is_alive() and b.is_alive()  # no message is taken before the wake has a worker
    release.set()
    a.join(10), b.join(10)
    wait_for(lambda: "first" in str(fake_llm.requests()) and "second" in str(fake_llm.requests()), what="both")
    assert jobs == ["resume"] and len(h.store.get_session(sid).run_ids) == 1


def test_a_prompt_while_the_wake_spawns_waits_for_it_and_is_delivered(make_harness, fake_llm, workspace):
    fake_llm.script({"content": "r1"}, {"content": "r2"})
    h, sid = asleep(make_harness, workspace)
    spawn, entered, release = h.registry.spawn, threading.Event(), threading.Event()

    def held(*args):
        entered.set()
        assert release.wait(10)
        return spawn(*args)

    h.registry.spawn = held
    a, _ = calling(h.prompt, sid, "first")
    assert entered.wait(10)
    assert h._live[sid].worker is None and sid in h._waking
    b, _ = calling(h.prompt, sid, "second")
    time.sleep(0.2)
    assert b.is_alive()  # it waits for the wake to settle, not on the worker-less entry
    release.set()
    a.join(10), b.join(10)
    wait_for(lambda: "first" in str(fake_llm.requests()) and "second" in str(fake_llm.requests()), what="both")


def test_a_steer_to_a_sleeping_session_wakes_it_and_is_its_next_message(make_harness, fake_llm, workspace):
    fake_llm.script({"content": "steered"})
    h, sid = asleep(make_harness, workspace)
    h.steer(sid, "look here")
    wait_for(lambda: texts(h, sid) == ["steered"], what="the reply")
    assert texts(h, sid, role="user") == ["look here"]


def test_a_wake_never_resumes_a_session_whose_finish_is_in_flight(make_harness, fake_llm, workspace):
    h = make_harness()
    sid = start(h, workspace)
    entered, release, ended = threading.Event(), threading.Event(), []

    def held(session):  # end_status runs inside _finish: after the live run is dropped, before the end is stored
        entered.set()
        assert release.wait(10)

    h.hooks.end_status.append(held)
    h.hooks.session_ended.append(lambda session: ended.append(session.status))
    h.end(sid)  # the exit: the worker finishes, and _finish runs on the dispatcher
    assert entered.wait(10)
    assert sid not in h._live and status(h, sid) == "ending"
    jobs = spawned(h)
    with pytest.raises(HarnessError) as err:
        h.prompt(sid, "late")
    assert (err.value.status, err.value.code) == (409, "not_live")
    release.set()
    wait_for(lambda: status(h, sid) == "ended", what="the end")
    assert jobs == [] and ended == ["ended"] and not h._finishing


def test_end_on_a_sleeping_session_runs_its_exit(make_harness, fake_llm, workspace):
    h, sid = asleep(make_harness, workspace)
    ended = []
    h.hooks.session_ended.append(lambda session: ended.append(session.status))
    h.end(sid)
    wait_for(lambda: status(h, sid) == "ended", what="the end")
    assert ended == ["ended"]
    assert fake_llm.requests() == []  # the exit needs no reply


def test_an_end_that_wakes_the_session_turns_a_racing_prompt_away(make_harness, fake_llm, workspace):
    h, sid = asleep(make_harness, workspace)
    entered, release = hold_builds(h)
    ender, _ = calling(h.end, sid)
    assert entered.wait(10)
    sender, got = calling(h.prompt, sid, "late")
    time.sleep(0.2)
    release.set()
    ender.join(10), sender.join(10)
    wait_for(lambda: status(h, sid) == "ended", what="the end")
    # ending while the run lives; not_live while _finish runs or after it
    assert got and got[0] in ((409, "ending"), (409, "not_live"))
    assert fake_llm.requests() == []


def test_an_end_racing_the_prompt_that_wakes_the_session_ends_it(make_harness, fake_llm, workspace):
    h, sid = asleep(make_harness, workspace)
    jobs = spawned(h, lambda job: job.kind)
    entered, release = hold_builds(h)
    sender, _ = calling(h.prompt, sid, "hi")
    assert entered.wait(10)
    ender, got = calling(h.end, sid)
    time.sleep(0.2)
    release.set()
    sender.join(10), ender.join(10)
    wait_for(lambda: status(h, sid) == "ended", what="the end")
    assert got == [None] and jobs == ["resume"]


def test_interrupt_on_a_sleeping_session_spawns_nothing(make_harness, fake_llm, workspace):
    h, sid = asleep(make_harness, workspace)
    jobs = spawned(h)
    assert h.interrupt(sid) is None
    assert jobs == [] and sid not in h._live and status(h, sid) == "idle"


def test_a_turn_answer_to_a_sleeping_session_is_its_next_message(make_harness, fake_llm, workspace):
    fake_llm.script({"content": "hi back"})
    h, sid = asleep(make_harness, workspace)
    turn = next(q for q in h.store.list_questions(session_id=sid, status="open") if MAIN_CHAT.is_turn(q.node_id))
    assert h.answer(turn.id, "hello", "text", by="ngocbh").id == turn.id
    wait_for(lambda: texts(h, sid) == ["hi back"], what="the reply")
    assert texts(h, sid, role="user") == ["hello"]


def test_a_wake_whose_provider_cant_resolve_answers_503_and_leaves_the_session_idle(make_harness, fake_llm,
                                                                                   workspace):
    fake_llm.script({"content": "back"})
    h, sid = asleep(make_harness, workspace)
    keys = h.office.paths.office / "provider.json"
    os.chmod(keys, 0o644)  # not private: the office's connection can't be read
    questions = [(q.id, q.status) for q in h.store.list_questions(session_id=sid)]
    with pytest.raises(HarnessError) as err:
        h.prompt(sid, "hi")
    assert (err.value.status, err.value.code) == (503, "cant_wake")
    assert status(h, sid) == "idle" and sid not in h._live and not h._waking
    assert [(q.id, q.status) for q in h.store.list_questions(session_id=sid)] == questions  # its cards are as they were
    assert len(h.store.get_session(sid).run_ids) == 1
    os.chmod(keys, 0o600)  # fixed: the next message wakes it
    assert say(h, sid, "hi") == "back"


def test_an_end_whose_wake_cant_resolve_fails_the_session(make_harness, fake_llm, workspace):
    h, sid = asleep(make_harness, workspace)
    os.chmod(h.office.paths.office / "provider.json", 0o644)
    with pytest.raises(HarnessError) as err:
        h.end(sid)
    assert err.value.code == "cant_wake" and status(h, sid) == "failed"


def test_a_wake_into_a_missing_folder_answers_422_and_leaves_the_session_idle(make_harness, fake_llm, workspace):
    h, sid = asleep(make_harness, workspace)
    shutil.rmtree(workspace)
    with pytest.raises(HarnessError) as err:
        h.prompt(sid, "hi")
    assert (err.value.status, err.value.code) == (422, "invalid_body")
    assert status(h, sid) == "idle" and sid not in h._live


def test_close_all_during_a_wake_answers_503_and_leaves_the_status(make_harness, fake_llm, workspace):
    h, sid = asleep(make_harness, workspace)
    entered, release = hold_builds(h)
    sender, got = calling(h.prompt, sid, "hi")
    assert entered.wait(10)
    closer = threading.Thread(target=h.close_all)
    closer.start()
    wait_for(lambda: h._stopping, what="close_all")
    release.set()
    sender.join(10), closer.join(15)
    assert got == [(503, "stopping")] and status(h, sid) == "idle" and sid not in h._live


def test_a_wake_whose_fresh_run_cant_spawn_stays_idle_and_the_next_wake_starts_fresh(make_harness, fake_llm,
                                                                                     workspace):
    fake_llm.script({"content": "b's reply"})
    first = make_harness(llm_config={**LLM_CONFIG, "api_key": "sk-wake-one"})
    sid = start(first, workspace)
    first.close_all()
    second = make_harness(llm_config={**LLM_CONFIG, "api_key": "sk-wake-two"})  # the key changed: a fresh run
    spawn, calls = second.registry.spawn, []

    def once_bad(*args):
        calls.append(1)
        if len(calls) == 1:
            raise OSError("can't start the worker")
        return spawn(*args)

    second.registry.spawn = once_bad
    with pytest.raises(HarnessError) as err:
        second.prompt(sid, "a")
    assert err.value.code == "cant_wake" and status(second, sid) == "idle" and sid not in second._live
    jobs = spawned(second, lambda job: job.kind)
    assert say(second, sid, "b") == "b's reply"
    assert jobs == ["chat"]  # the run that never started isn't resumed


def test_an_answered_unread_turn_resumes_at_start(make_harness, fake_llm, workspace):
    fake_llm.script({"content": "read it"})
    first = make_harness()
    sid = start(first, workspace)
    turn = first._live[sid].turn_q
    first.close_all()
    first.store.answer_question(turn, "hello", "text", answered_by="ngocbh")  # stored just before the office died
    second = make_harness()
    second.restore()
    assert sid in second._live
    wait_for(lambda: texts(second, sid) == ["read it"], what="the reply to the stored answer")
    assert "hello" in str(fake_llm.requests()[0]["messages"])


def test_worker_exit_right_after_wake_spawn_is_misread_as_stopping(make_harness, fake_llm, workspace):
    """A woken worker that exits before the wake returns isn't taken for a stopping office: the wake stands, and
    the worker its exit respawns stays the session's."""
    fake_llm.script({"content": "one"}, {"content": "two"})
    h, sid = asleep(make_harness, workspace)
    spawn, second_spawn, go, n = h.registry.spawn, threading.Event(), threading.Event(), []

    def spy(*args):
        n.append(1)
        if len(n) == 2:  # the respawn after the exit, under the harness lock
            second_spawn.set()
            assert go.wait(10)
        return spawn(*args)

    h.registry.spawn = spy
    resume, first = h._resume, []

    def killing(live):
        resume(live)
        if not first:
            first.append(1)
            os.killpg(live.worker.pgid, signal.SIGKILL)
            assert second_spawn.wait(10)  # _exited cleared live.worker and is respawning
            threading.Timer(0.3, go.set).start()

    h._resume = killing
    assert h.prompt(sid, "hi") in ("queued", "turn")
    wait_for(lambda: texts(h, sid) == ["one"] and status(h, sid) == "idle", what="the reply")
    assert not h._stopping and sid in h._live
    assert say(h, sid, "again") == "two"


def test_a_codex_session_is_never_woken_as_a_composer_one(make_harness, fake_llm, workspace):
    from opencorp.store import new_id

    h, sid = asleep(make_harness, workspace)  # this harness has no Codex sessions to hand it to
    codex = h.store.create_session(h.store.get_session(sid).model_copy(
        update={"id": new_id(), "harness": "codex", "run_ids": []}))
    h.store.add_session_run(codex.id, new_id())
    jobs = spawned(h)
    with pytest.raises(HarnessError) as err:
        h.prompt(codex.id, "hi")
    assert (err.value.status, err.value.code) == (409, "not_live") and jobs == []

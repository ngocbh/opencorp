"""Waking a sleeping session: one wake at a time, nothing lost, failures leave it as it was."""

import threading
import time

import pytest

from opencorp.chat.harness import HarnessError
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

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

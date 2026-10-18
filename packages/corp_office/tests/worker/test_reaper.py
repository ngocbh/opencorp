import os
import signal
import subprocess
import sys

import psutil
import pytest

from opencorp.worker.reaper import kill_group, reap

from tests.worker.conftest import Recorder, run

# A process-group leader that starts a grandchild and prints its pid, as a worker running a shell tool would.
LEADER = ("import subprocess, sys, time\n"
          "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
          "print(child.pid, flush=True)\n"
          "time.sleep(60)\n")


@pytest.fixture
def leftovers():
    procs = []

    def start(code: str = "import time; time.sleep(60)") -> subprocess.Popen:
        proc = subprocess.Popen([sys.executable, "-c", code], start_new_session=True, stdout=subprocess.PIPE, text=True)
        procs.append(proc)
        return proc

    yield start
    for proc in procs:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()


def record(store, session_id, proc, *, skew=0.0):
    store.record_worker(session_id, pid=proc.pid, pgid=proc.pid,
                        start_time=psutil.Process(proc.pid).create_time() + skew)


def test_reap_kills_a_leftover_process_group(store, leftovers):
    leader = leftovers(LEADER)
    child = psutil.Process(int(leader.stdout.readline()))
    record(store, "s1", leader)
    assert [r.session_id for r in reap(store)] == ["s1"]
    assert leader.wait(5) == -signal.SIGKILL
    child.wait(5)
    assert store.list_workers() == []


def test_reap_leaves_a_reused_pid_alone(store, leftovers):
    stranger = leftovers()
    record(store, "s1", stranger, skew=-100.0)
    assert reap(store) == []
    assert stranger.poll() is None and store.list_workers() == []


def test_reap_forgets_a_dead_worker(store, leftovers):
    gone = leftovers("pass")
    gone.wait()
    store.record_worker("s1", pid=gone.pid, pgid=gone.pid, start_time=0.0)
    assert reap(store) == [] and store.list_workers() == []


def test_reap_one_session(store, leftovers):
    first, second = leftovers(), leftovers()
    record(store, "s1", first)
    record(store, "s2", second)
    assert [r.session_id for r in reap(store, "s2")] == ["s2"]
    assert second.wait(5) == -signal.SIGKILL and first.poll() is None
    assert [r.session_id for r in store.list_workers()] == ["s1"]


def test_kill_group_ignores_a_group_it_may_not_signal(monkeypatch):
    def refuse(pgid, sig):
        raise PermissionError(1, "Operation not permitted")  # macOS, for a group of only zombies

    monkeypatch.setattr(os, "killpg", refuse)
    assert kill_group(12345) is False


def test_spawn_reaps_a_leftover_worker_of_the_session(fake_llm, store, registry, make_job, session_dir, leftovers):
    stale = leftovers()
    record(store, "s1", stale)
    fake_llm.script({"content": "fresh"})
    rec = run(registry, make_job(), Recorder(), session_dir)
    assert stale.wait(5) == -signal.SIGKILL and rec.outcome["output"] == "fresh"

import os
import signal
import socket
import sqlite3
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import psutil
import pytest

from agent_corp.worker import channel as channel_module
from agent_corp.worker import spawn as spawn_module
from agent_corp.worker.channel import Channel, FrameTooLarge
from agent_corp.worker.main import EXIT_ORPHANED, job_tools
from agent_corp.worker.spawn import Worker, WorkerExists, WorkerRegistry

from tests.worker.conftest import Recorder, office_end, run


def test_a_chat_job_streams_events_and_a_result(fake_llm, registry, store, make_job, session_dir):
    fake_llm.script({"content": "hello there"})
    rec = run(registry, make_job(), Recorder(), session_dir)
    assert rec.returncode == 0
    assert rec.outcome == {"type": "result", "status": "succeeded", "run_id": "r1", "output": "hello there",
                           "failure": None, "backward": None}
    names = rec.names()
    assert names[0] == "RunStarted" and names[-1] == "RunSucceeded"
    reply = [i for i, f in enumerate(rec.frames) if f.get("data", {}).get("node_id") == "reply"
             or f.get("node_id") == "reply"]
    kinds = [rec.frames[i].get("name", "stream") for i in reply]
    assert kinds[0] == "NodeStarted" and kinds[-1] == "NodeSucceeded" and "stream" in kinds
    assert "".join(f["chunk"] for f in rec.frames if f["type"] == "stream") == "hello there"
    assert registry.get("s1") is None and store.list_workers() == []
    assert (session_dir / "worker.log").exists()


def test_a_running_worker_is_recorded_and_isolated(fake_llm, registry, store, make_job, session_dir,
                                                   monkeypatch):
    monkeypatch.setenv("OFFICE_SECRET", "office-env-secret")
    monkeypatch.setenv("LC_CTYPE", "UTF-8")
    fake_llm.script({"content": "slow", "hold": 20})
    rec = Recorder()
    worker = registry.spawn(make_job(), session_dir, rec)
    fake_llm.wait_for_requests(1, timeout=30)
    [record] = store.list_workers()
    proc = psutil.Process(worker.pid)
    assert (record.session_id, record.pid, record.pgid) == ("s1", worker.pid, worker.pid)
    assert abs(record.start_time - proc.create_time()) < 0.01
    assert os.getpgid(worker.pid) == worker.pid
    assert Path(proc.cwd()).resolve() == session_dir.resolve()
    assert proc.cmdline()[1:4] == ["-I", "-m", "agent_corp.worker.main"]
    env = proc.environ()
    assert "VLLM_BASE_URL" not in env  # it arrives in the start frame
    assert "OFFICE_SECRET" not in env  # only an allowlist of the office's env is passed on
    assert env["LC_CTYPE"] == "UTF-8" and env["PATH"] == os.environ["PATH"]
    fake_llm.release()
    assert worker.wait(30) == 0 and rec.outcome["output"] == "slow"


def test_a_model_ask_user_call_reaches_the_office(fake_llm, registry, make_job, session_dir):
    fake_llm.script({"tool_calls": [{"name": "ask_user", "arguments": {"question": "Which city?",
                                                                      "options": ["Paris", "Rome"]}}]},
                    {"content": "Booked Paris."})
    rec = run(registry, make_job("flows/ask.yaml"), Recorder(answers=["Paris"]), session_dir)
    [asked] = rec.asked
    assert (asked["question"], asked["node_id"], asked["options"]) == ("Which city?", None, ["Paris", "Rome"])
    assert rec.outcome["output"] == "Booked Paris."
    assert "Paris" in str(fake_llm.requests()[-1]["messages"])


def test_a_human_input_node_asks_through_the_same_stub(fake_llm, registry, make_job, session_dir):
    fake_llm.script({"content": "hello"})
    rec = run(registry, make_job("flows/chat.yaml", inputs={}), Recorder(answers=["hi there"]), session_dir)
    [asked] = rec.asked
    assert (asked["question"], asked["node_id"]) == ("you> ", "ask")
    assert rec.outcome["output"] == "hello" and "hi there" in str(fake_llm.requests()[-1]["messages"])


def test_one_live_worker_per_session(fake_llm, registry, make_job, session_dir, tmp_path):
    fake_llm.script({"content": "one", "hold": 20}, {"content": "two"}, {"content": "three"})
    first = registry.spawn(make_job(), session_dir, Recorder())
    with pytest.raises(WorkerExists):
        registry.spawn(make_job(run_id="r2"), session_dir, Recorder())
    other = registry.spawn(make_job(session_id="s2", run_id="r3"), tmp_path / "sessions" / "s2", Recorder())
    assert other.wait(30) == 0
    fake_llm.release()
    assert first.wait(30) == 0
    assert run(registry, make_job(run_id="r4"), Recorder(), session_dir).returncode == 0


def test_a_job_that_raises_sends_an_error_frame(fake_llm, registry, make_job, session_dir):
    rec = run(registry, make_job("flows/missing.yaml"), Recorder(), session_dir)
    assert rec.returncode == 1
    assert rec.outcome["type"] == "error" and rec.outcome["message"].startswith("FileNotFoundError")
    assert "Traceback" in rec.outcome["traceback"]
    assert fake_llm.requests() == []


def test_a_failed_run_is_a_result(fake_llm, registry, make_job, session_dir):
    fake_llm.script({"error": 500})
    rec = run(registry, make_job(), Recorder(), session_dir)
    assert rec.returncode == 0
    assert rec.outcome["status"] == "failed" and rec.outcome["failure"]["node_id"] == "reply"


def test_a_failing_handler_does_not_stop_the_reader(fake_llm, registry, make_job, session_dir):
    class Broken(Recorder):
        def event(self, worker, frame):
            raise RuntimeError("handler bug")

    fake_llm.script({"content": "fine"})
    rec = run(registry, make_job(), Broken(), session_dir)
    assert rec.returncode == 0 and rec.outcome["output"] == "fine"


def test_a_worker_exits_when_the_office_closes_its_channel(fake_llm, registry, make_job, session_dir):
    fake_llm.script({"content": "never", "hold": 20})
    registry.spawn(make_job(), session_dir, Recorder())
    fake_llm.wait_for_requests(1, timeout=30)
    assert registry.close("s1", timeout=10) == EXIT_ORPHANED


def test_close_kills_a_worker_that_does_not_exit(fake_llm, registry, make_job, session_dir):
    fake_llm.script({"content": "never", "hold": 20})
    worker = registry.spawn(make_job(), session_dir, Recorder())
    fake_llm.wait_for_requests(1, timeout=30)
    os.kill(worker.pid, signal.SIGSTOP)  # it can't see the channel close
    assert registry.close("s1", timeout=1) == -signal.SIGKILL


@pytest.mark.parametrize("kind", ["chat", "resume", "backward"])
def test_every_job_kind_gets_the_ask_user_stub(kind, make_job):
    job = make_job(kind=kind, groups={"toolbox": [{"name": "shout"}]})
    with office_end(Recorder()) as rpc:
        tools = job_tools(job, rpc)
    assert set(tools) == {"toolbox", "ask_user"}
    assert [t.name for t in tools["toolbox"]] == ["shout"] and callable(tools["ask_user"])


def test_a_worker_exiting_during_a_store_transaction_does_not_deadlock(store):
    # The store holds its write lock through a transaction (and while listeners run); the
    # registry must never make a store write while holding its own lock.
    registry = WorkerRegistry(store)
    worker = SimpleNamespace(session_id="s1")
    registry._workers["s1"] = worker
    store.record_worker("s1", pid=1, pgid=1, start_time=0.0)
    in_tx, done = threading.Event(), []

    def office():
        with store.transaction():
            in_tx.set()
            time.sleep(0.3)  # the exiting worker's reader takes the registry lock meanwhile
            registry.get("s1")
        done.append("office")

    def reader():
        in_tx.wait()
        time.sleep(0.1)
        registry._exited(worker)
        done.append("reader")

    threads = [threading.Thread(target=f, daemon=True) for f in (office, reader)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(8)
    assert sorted(done) == ["office", "reader"], "deadlock"
    assert registry.get("s1") is None and store.list_workers() == []


def test_a_failing_exit_step_still_finishes_the_worker(fake_llm, registry, store, make_job, session_dir,
                                                       monkeypatch):
    def broken(session_id):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(store, "remove_worker", broken)
    fake_llm.script({"content": "fine"})
    rec = run(registry, make_job(), Recorder(), session_dir)
    assert rec.returncode == 0 and rec.outcome["output"] == "fine"


def test_a_start_frame_that_cannot_be_sent_leaves_nothing_behind(fake_llm, registry, store, make_job,
                                                                  session_dir, monkeypatch):
    started = []

    def spawn_and_keep(path):
        proc, sock = real_spawn_process(path)
        started.append(proc)
        return proc, sock

    real_spawn_process = spawn_module.spawn_process
    monkeypatch.setattr(spawn_module, "spawn_process", spawn_and_keep)
    fds = psutil.Process().num_fds()
    monkeypatch.setattr(channel_module, "MAX_FRAME", 2000)  # the office side only, as for a >64 MiB job
    with pytest.raises(FrameTooLarge):
        registry.spawn(make_job(inputs={"message": "x" * 5000}), session_dir, Recorder())
    [proc] = started
    assert proc.returncode is not None  # killed and reaped
    assert registry.get("s1") is None and store.list_workers() == []
    assert psutil.Process().num_fds() == fds
    monkeypatch.setattr(channel_module, "MAX_FRAME", 64 << 20)
    fake_llm.script({"content": "second try"})
    assert run(registry, make_job(), Recorder(), session_dir).outcome["output"] == "second try"


def unstarted_worker(job, handlers):
    """A ``Worker`` over an in-process socket pair, with no process; returns it and the worker's end."""
    office_sock, worker_sock = socket.socketpair()
    return Worker(job, SimpleNamespace(pid=0), Channel(office_sock), handlers, lambda w: None), Channel(worker_sock)


def test_a_reply_that_cannot_be_sent_becomes_a_failed_reply(make_job, monkeypatch):
    def big() -> str:
        """Big."""
        return "x" * 5000

    worker, far = unstarted_worker(make_job(), Recorder(tools={"g": {"big": big}}))
    monkeypatch.setattr(channel_module, "MAX_FRAME", 2000)
    worker._answer({"type": "tool_call", "id": 7, "group": "g", "name": "big"})
    reply = far.recv()
    assert (reply["type"], reply["id"], reply["error"]) == ("tool_result", 7, "failed")


def test_a_request_without_an_id_is_answered_without_raising(make_job):
    worker, far = unstarted_worker(make_job(), Recorder())
    worker._answer({"type": "tool_call", "group": "g", "name": "missing"})
    reply = far.recv()
    assert (reply["type"], reply["id"], reply["error"]) == ("tool_result", None, "failed")

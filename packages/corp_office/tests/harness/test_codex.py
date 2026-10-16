"""Starting and stopping one app-server: command, environment, process group, worker record."""

import json
import os
import sys
import threading
from pathlib import Path

import psutil
import pytest
from jsonschema import Draft7Validator

from agent_corp.harness.codex import (CodexMissing, CodexProcess, CodexSignedOut, CodexStartError, codex_command,
                                     owner_load)
from agent_corp.protocol.models import HarnessPolicy
from agent_corp.store import Store
from agent_corp.worker.reaper import start_time
from tests.chat.conftest import wait_for

CLIENT = Draft7Validator(json.loads(
    (Path(__file__).parent / "fixtures" / "codex" / "schema" / "ClientRequest.json").read_text()))


def test_owner_load_takes_the_persons_policy():
    assert owner_load("/w", HarnessPolicy(sandbox="workspace-write", network=True)) == {
        "cwd": "/w", "sandbox": "workspace-write", "approvalPolicy": "on-request", "approvalsReviewer": "user",
        "config": {"sandbox_workspace_write": {"network_access": True}}}
    assert owner_load("/w", None)["sandbox"] == "read-only"
    assert owner_load("/w", None)["config"] == {"sandbox_workspace_write": {"network_access": False}}
    for policy in (None, HarnessPolicy(sandbox="workspace-write", network=True)):  # loads Codex takes
        CLIENT.validate({"id": 1, "method": "thread/start", "params": owner_load("/w", policy)})
        CLIENT.validate({"id": 2, "method": "thread/resume", "params": {"threadId": "t", **owner_load("/w", policy)}})


def test_codex_command_finds_codex_on_the_office_path(tmp_path):
    (tmp_path / "codex").write_text("#!/bin/sh\n")
    (tmp_path / "codex").chmod(0o755)
    assert codex_command({"PATH": str(tmp_path)}) == [str(tmp_path / "codex"), "app-server", "--listen", "stdio://"]
    with pytest.raises(CodexMissing, match="isn't installed"):
        codex_command({"PATH": str(tmp_path / "empty")})


def fake(tmp_path, script=None):
    path = tmp_path / "s.json"
    path.write_text(json.dumps(script or {}))
    return [sys.executable, "-I", "-m", "agent_corp.testing.fake_codex", "--script", str(path),
            "--log", str(tmp_path / "log.jsonl")]


def process(tmp_path, store, script=None, **over):
    exits = threading.Event()
    return CodexProcess(store, "harness:S1", command=fake(tmp_path, script), cwd=str(tmp_path), env=dict(os.environ),
                        log=tmp_path / "codex.log", on_notification=lambda m, p: None,
                        on_request=lambda i, m, p: None, on_exit=lambda p: exits.set(), **over), exits


def test_start_initializes_and_records_the_group_close_removes_it(tmp_path):
    with Store(tmp_path / "store.sqlite") as store:
        p, exits = process(tmp_path, store)
        p.start()
        log = [json.loads(line)["msg"] for line in (tmp_path / "log.jsonl").read_text().splitlines()]
        init = next(m for m in log if m.get("method") == "initialize")
        assert init["params"]["capabilities"] == {"experimentalApi": True}
        assert any(m.get("method") == "initialized" for m in log)
        for request in (m for m in log if "method" in m and "id" in m):
            CLIENT.validate(request)  # what the office sends must be what Codex takes
        [record] = store.list_workers()
        assert record.session_id == "harness:S1" and record.pgid == p.pid and p.alive
        p.close(grace=1)
        assert not p.alive and store.list_workers() == [] and start_time(p.pid) is None


def test_a_server_that_dies_calls_on_exit_with_its_stderr(tmp_path):
    with Store(tmp_path / "store.sqlite") as store:
        p, exits = process(tmp_path, store, {"stderr": "boom: bad config", "turns": [[{"exit": 3}]]})
        p.start()
        p.rpc.request("thread/start", {"cwd": str(tmp_path)})
        p.rpc.request("turn/start", {"threadId": "thr_fake", "input": []})
        assert exits.wait(10) and "boom: bad config" in p.stderr_tail()


def test_a_refused_handshake_or_sign_in_raises_and_leaves_nothing(tmp_path):
    with Store(tmp_path / "store.sqlite") as store:
        p, _ = process(tmp_path, store, {"initialize_error": {"code": -32600, "message": "bad"}, "stderr": "why"})
        with pytest.raises(CodexStartError) as e:
            p.start()
        assert "why" in e.value.tail and store.list_workers() == [] and not p.alive
        p, _ = process(tmp_path, store, {"account": None})
        with pytest.raises(CodexSignedOut):
            p.start()
        assert store.list_workers() == []


def test_a_process_killed_before_it_starts_never_spawns(tmp_path):
    # Office stop can kill a session's app-server while the session is still about to start it.
    with Store(tmp_path / "store.sqlite") as store:
        p, _ = process(tmp_path, store)
        p.kill()
        with pytest.raises(CodexStartError):
            p.start()
        assert p.proc is None and store.list_workers() == []


def test_killing_an_old_app_server_again_leaves_the_new_ones_record(tmp_path):
    with Store(tmp_path / "store.sqlite") as store:
        old, _ = process(tmp_path, store)
        old.start()
        old.kill()
        new, _ = process(tmp_path, store)  # a reload: the same key
        new.start()
        old.kill()
        assert [r.pid for r in store.list_workers()] == [new.pid]
        new.close(grace=1)
        assert store.list_workers() == []


def test_an_old_app_server_that_died_by_itself_leaves_its_replacements_record(tmp_path):
    with Store(tmp_path / "store.sqlite") as store:
        old, exits = process(tmp_path, store, {"turns": [[{"exit": 1}]]})
        old.start()
        old.rpc.request("thread/start", {"cwd": str(tmp_path)})
        old.rpc.request("turn/start", {"threadId": "thr_fake", "input": []})
        assert exits.wait(10)
        new, _ = process(tmp_path, store)  # restarted under the same key before the old one was cleaned up
        new.start()
        old.kill()
        assert [r.pid for r in store.list_workers()] == [new.pid] and new.alive
        new.close(grace=1)


def test_close_kills_the_commands_left_in_its_group(tmp_path):
    with Store(tmp_path / "store.sqlite") as store:
        p, _ = process(tmp_path, store, {"turns": [[{"spawn": 300}, {"sleep": 30}]]})
        p.start()
        p.rpc.request("thread/start", {"cwd": str(tmp_path)})
        p.rpc.request("turn/start", {"threadId": "thr_fake", "input": []})
        [child] = wait_for(lambda: [e["pid"] for e in (json.loads(line) for line in
                                    (tmp_path / "log.jsonl").read_text().splitlines()) if e["dir"] == "spawn"],
                           what="the command")
        p.close(grace=1)
        wait_for(lambda: gone(child), timeout=5, what="the command to die")


def gone(pid):
    try:
        return psutil.Process(pid).status() == psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return True

"""The JSON-RPC client over a child's stdio."""

import json
import subprocess
import sys
import threading

import pytest

from agent_corp.harness.rpc import JsonRpc, RpcClosed, RpcError
from agent_corp.testing import fake_codex as fc
from tests.chat.conftest import wait_for


def connect(tmp_path, script, **handlers):
    path = tmp_path / "s.json"
    path.write_text(json.dumps(script))
    proc = subprocess.Popen([sys.executable, "-I", "-m", "agent_corp.testing.fake_codex", "--script", str(path),
                             "--log", str(tmp_path / "log.jsonl")], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    seen, closed = [], threading.Event()
    rpc = JsonRpc(proc.stdin, proc.stdout,
                  on_notification=handlers.get("on_notification", lambda m, p: seen.append((m, p))),
                  on_request=handlers.get("on_request", lambda i, m, p: seen.append((i, m, p))),
                  on_closed=closed.set)
    rpc.start()
    return proc, rpc, seen, closed


def test_requests_get_their_results_and_errors(tmp_path):
    proc, rpc, seen, closed = connect(tmp_path, {})
    assert rpc.request("initialize", {})["userAgent"] == "fake-codex/0.0.0"
    with pytest.raises(RpcError) as e:
        rpc.request("no/such", {})
    assert e.value.code == -32601
    proc.stdin.close()
    assert closed.wait(5)
    with pytest.raises(RpcClosed):
        rpc.request("initialize", {})


def test_server_requests_and_notifications_reach_the_handlers_in_order(tmp_path):
    script = {"turns": [[fc.command_approval(7, "c1", "touch a"), *fc.agent_message("m1", "ok")]]}
    proc, rpc, seen, closed = connect(tmp_path, script)
    rpc.request("thread/start", {"cwd": str(tmp_path)})
    rpc.request("turn/start", {"threadId": "thr_fake", "input": []})
    request = wait_for(lambda: next((s for s in seen if isinstance(s[0], int)), None), what="the approval")
    assert request[:2] == (7, "item/commandExecution/requestApproval")
    rpc.reply(7, {"decision": "accept"})
    wait_for(lambda: any(s[0] == "turn/completed" for s in seen), what="the turn's end")
    assert [s[0] for s in seen if isinstance(s[0], str)][:3] == ["turn/started", "serverRequest/resolved",
                                                                 "item/started"]
    log = [json.loads(line)["msg"] for line in (tmp_path / "log.jsonl").read_text().splitlines()]
    assert {"id": 7, "result": {"decision": "accept"}} in log
    proc.stdin.close()
    proc.wait(5)

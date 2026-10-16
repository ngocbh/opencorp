"""The JSON-RPC client over a child's stdio."""

import json
import os
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


class Server:
    """The other end of a ``JsonRpc`` over two pipes, written and read by the test."""

    def __init__(self, **handlers):
        to_server, from_client = os.pipe()
        to_client, from_server = os.pipe()
        self.inbox, self.outbox = os.fdopen(to_server, "rb"), os.fdopen(from_server, "wb", buffering=0)
        self.closed = threading.Event()
        self.client_in, self.client_out = os.fdopen(from_client, "wb"), os.fdopen(to_client, "rb")
        self.rpc = JsonRpc(self.client_in, self.client_out,
                           on_notification=handlers.get("on_notification", lambda m, p: None),
                           on_request=handlers.get("on_request", lambda i, m, p: None), on_closed=self.closed.set)
        self.rpc.start()

    def close(self):
        self.outbox.close()
        assert self.closed.wait(5)
        for f in (self.inbox, self.client_in, self.client_out):
            f.close()

    def write(self, line):
        self.outbox.write((line if isinstance(line, str) else json.dumps(line)).encode() + b"\n")

    def read(self):
        return json.loads(self.inbox.readline())

    def answer_next(self, result):
        """Answer the next request the client sends with ``result``."""
        self.write({"id": self.read()["id"], "result": result})


def ask(server, method):
    """``server.rpc.request(method)`` on a thread; returns a box that gets its result."""
    box = []
    thread = threading.Thread(target=lambda: box.append(server.rpc.request(method, {}, timeout=5)))
    thread.start()
    return thread, box


def test_a_handler_that_raises_leaves_the_connection_reading():
    seen = []

    def on_notification(method, params):
        seen.append(method)
        if method == "boom":
            raise RuntimeError("a bug in a handler")

    server = Server(on_notification=on_notification)
    server.write({"method": "boom", "params": {}})
    thread, box = ask(server, "initialize")
    server.answer_next({"ok": True})
    thread.join(5)
    assert box == [{"ok": True}] and not server.closed.is_set()
    server.write({"method": "after", "params": {}})
    wait_for(lambda: "after" in seen, timeout=5, what="the next notification")
    server.close()


def test_a_line_that_isnt_a_json_object_is_skipped():
    seen = []
    server = Server(on_notification=lambda m, p: seen.append(m))
    for line in ("123", "[1, 2]", '"text"', "null", "not json"):
        server.write(line)
    server.write({"method": "after", "params": {}})
    wait_for(lambda: seen == ["after"], timeout=5, what="the notification after the bad lines")
    assert not server.closed.is_set()
    server.close()


def test_a_request_handler_that_raises_answers_codex_with_an_error():
    def on_request(request_id, method, params):
        raise RuntimeError("a bug in a handler")

    server = Server(on_request=on_request)
    server.write({"id": 0, "method": "item/commandExecution/requestApproval", "params": {}})
    reply = server.read()
    assert (reply["id"], reply["error"]["code"]) == (0, -32603) and not server.closed.is_set()
    server.close()

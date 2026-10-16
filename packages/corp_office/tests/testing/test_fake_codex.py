"""The fake Codex app-server: scripted turns over stdio, every message it sends valid against the pinned schema."""

import json
import subprocess
import sys
from pathlib import Path

import pytest
from jsonschema import Draft7Validator

from agent_corp.testing import fake_codex as fc

SCHEMA = Path(__file__).parents[1] / "harness" / "fixtures" / "codex" / "schema"


def validator(name):
    return Draft7Validator(json.loads((SCHEMA / f"{name}.json").read_text()))


def every_script():
    yield "e2e", fc.e2e()
    yield "builders", {"turns": [[
        *fc.agent_message("m1", "hi"), *fc.command("c1", "ls", output="a"), fc.command_approval(0, "c1", "touch a"),
        *fc.file_change("f1", "notes.md", "hi\n"),
        *fc.file_change("f2", "a.py", "@@ -1 +1 @@\n-a\n+b\n", kind="update"),
        *fc.file_change("f3", "b.py", "gone\n", kind="delete"), fc.file_change_approval(2, "f1"),
        fc.permissions_approval(3, "p1"), fc.user_input(4, "u1", [fc.question("token", "Token", "Token?", secret=True)]),
        fc.mcp_approval(5, "docs", "search"), fc.mcp_approval_question(6, "u2", "docs", "search"),
        fc.network_approval(7, "c2", "example.com"), fc.url_elicitation(8, "gh", "Sign in", "https://example.com/l"),
        fc.form_elicitation(9, "jira", "Ticket", {"points": {"type": "integer"}}),
        fc.token_usage(10, 4, 2), fc.error("rate limited", will_retry=True), fc.thread_closed()]]}


@pytest.mark.parametrize(("name", "script"), list(every_script()), ids=lambda v: v if isinstance(v, str) else "")
def test_fake_scripts_match_the_pinned_schema(name, script):
    notes, requests = validator("ServerNotification"), validator("ServerRequest")
    for turn in script["turns"]:
        for step in turn:
            if "notify" in step:
                notes.validate(fc.fill({"method": step["notify"], "params": step.get("params", {})}, "turn_0", "/w"))
            elif "request" in step:
                requests.validate(fc.fill({"id": step["id"], "method": step["request"],
                                           "params": step.get("params", {})}, "turn_0", "/w"))


def test_a_new_file_is_sent_as_its_content_and_an_update_as_a_diff():
    added = fc.file_change("f1", "notes.md", "hi\n")[1]["params"]["item"]["changes"][0]
    updated = fc.file_change("f2", "a.py", "@@ -1 +1 @@\n-a\n+b\n", kind="update")[1]["params"]["item"]["changes"][0]
    assert (added["kind"], added["diff"]) == ({"type": "add"}, "hi\n")
    assert updated["kind"] == {"type": "update", "move_path": None}


def run(tmp_path, script, *lines):
    path = tmp_path / "s.json"
    path.write_text(json.dumps(script))
    proc = subprocess.run([sys.executable, "-I", "-m", "agent_corp.testing.fake_codex", "--script", str(path),
                           "--log", str(tmp_path / "log.jsonl")],
                          input="".join(json.dumps(m) + "\n" for m in lines), capture_output=True, text=True, timeout=20)
    return [json.loads(line) for line in proc.stdout.splitlines()]


def log(tmp_path):
    return [json.loads(line) for line in (tmp_path / "log.jsonl").read_text().splitlines()]


START = [{"id": 1, "method": "initialize", "params": {}}, {"id": 2, "method": "thread/start", "params": {"cwd": "/w"}},
         {"id": 3, "method": "turn/start", "params": {"threadId": "thr_fake", "input": []}}]


def test_it_answers_the_handshake_and_a_load_and_refuses_the_rest(tmp_path):
    out = run(tmp_path, {"thread": {"id": "thr_9", "model": "gpt-x"}}, START[0],
              {"id": 2, "method": "account/read", "params": {}},
              {"id": 3, "method": "thread/resume", "params": {"threadId": "thr_7", "cwd": "/w"}},
              {"id": 4, "method": "no/such", "params": {}})
    answers = {m["id"]: m for m in out}
    assert answers[1]["result"] == {"userAgent": "fake-codex/0.0.0"}
    assert answers[2]["result"]["account"] == {"type": "chatgpt"}
    assert (answers[3]["result"]["thread"]["id"], answers[3]["result"]["model"]) == ("thr_7", "gpt-x")
    assert answers[4]["error"]["code"] == -32601
    assert {e["dir"] for e in log(tmp_path)} == {"in", "out"}


def test_doctor_questions_get_fake_answers():
    version = subprocess.run([sys.executable, "-I", "-m", "agent_corp.testing.fake_codex", "--version"],
                             capture_output=True, text=True, timeout=20)
    assert version.stdout.strip() == "codex-cli 0.0.0-fake"


class Live:
    """A fake app-server driven line by line: each read waits for what the fake actually sent."""

    def __init__(self, tmp_path, script):
        path = tmp_path / "s.json"
        path.write_text(json.dumps(script))
        self.proc = subprocess.Popen([sys.executable, "-I", "-m", "agent_corp.testing.fake_codex", "--script",
                                      str(path), "--log", str(tmp_path / "log.jsonl")],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.out = []

    def send(self, *msgs):
        self.proc.stdin.write("".join(json.dumps(m) + "\n" for m in msgs))
        self.proc.stdin.flush()

    def until(self, predicate):
        """Read what the fake sends until a message ``predicate`` takes; return it."""
        while True:
            line = self.proc.stdout.readline()
            assert line, "the fake exited"
            self.out.append(json.loads(line))
            if predicate(self.out[-1]):
                return self.out[-1]

    def methods(self):
        return [m.get("method") for m in self.out]

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(5)
        self.proc.stdout.close()


def method(name):
    return lambda m: m.get("method") == name


def test_a_turn_runs_its_steps_and_completes(tmp_path):
    live = Live(tmp_path, {"turns": [fc.agent_message("m1", "hello")]})
    live.send(*START)
    completed = live.until(method("turn/completed"))
    assert [m.get("method", "result") for m in live.out][:4] == ["result", "result", "result", "turn/started"]
    assert completed["params"]["turn"]["status"] == "completed"
    live.close()


def test_a_turn_start_during_a_turn_answers_with_the_running_turn(tmp_path):
    live = Live(tmp_path, {"turns": [[{"sleep": 30}]]})
    live.send(*START)
    live.until(method("turn/started"))
    live.send({"id": 4, "method": "turn/start", "params": {"threadId": "thr_fake", "input": []}})
    steer = live.until(lambda m: m.get("id") == 4)
    answers = {m["id"]: m["result"] for m in live.out if "result" in m}
    assert answers[3]["turn"]["id"] == steer["result"]["turn"]["id"] == "turn_1"
    assert live.methods().count("turn/started") == 1
    live.close()


def test_a_reply_is_followed_by_server_request_resolved_before_the_turn_goes_on(tmp_path):
    live = Live(tmp_path, {"turns": [[fc.command_approval(7, "c1", "touch a"), *fc.agent_message("m1", "ok")]]})
    live.send(*START)
    live.until(method("item/commandExecution/requestApproval"))
    live.send({"id": 7, "result": {"decision": "accept"}})
    live.until(method("turn/completed"))
    methods = live.methods()
    assert methods.count("serverRequest/resolved") == 1
    assert methods.index("serverRequest/resolved") < methods.index("item/agentMessage/delta")
    assert next(m for m in live.out if m.get("method") == "serverRequest/resolved")["params"]["requestId"] == 7
    notes, requests = validator("ServerNotification"), validator("ServerRequest")
    for m in (m for m in live.out if "method" in m):  # what the fake makes itself is Codex's shape too
        (requests if "id" in m else notes).validate(m)
    live.close()


def test_a_spawn_step_logs_its_childs_pid(tmp_path):
    live = Live(tmp_path, {"turns": [[{"spawn": 1}]]})
    live.send(*START)
    live.until(method("turn/completed"))
    live.close()
    [entry] = [e for e in log(tmp_path) if e["dir"] == "spawn"]
    assert entry["pid"] > 0


INTERRUPT = {"id": 4, "method": "turn/interrupt", "params": {"threadId": "thr_fake", "turnId": "turn_1"}}


def test_an_interrupt_completes_the_turn_before_it_resolves_the_waiting_requests(tmp_path):
    # Real Codex (sessions/interrupt.jsonl) sends turn/completed, then serverRequest/resolved; its ids start at 0.
    live = Live(tmp_path, {"turns": [[fc.command_approval(0, "c1", "touch a")]]})
    live.send(*START)
    live.until(method("item/commandExecution/requestApproval"))
    live.send(INTERRUPT)
    resolved = live.until(method("serverRequest/resolved"))
    assert resolved["params"]["requestId"] == 0
    completed = next(m for m in live.out if m.get("method") == "turn/completed")
    assert completed["params"]["turn"]["status"] == "interrupted"
    assert live.methods().index("turn/completed") < live.methods().index("serverRequest/resolved")
    live.close()


def test_a_turn_start_once_a_turn_ends_never_starts_the_next_turn_before_the_old_one_completes(tmp_path):
    # Many requests still waiting make the end of the interrupted turn long, and the first serverRequest/resolved
    # says it has ended: a turn/start sent then must not have turn_2 start before turn_1 completes.
    waiting = [fc.command_approval(n, f"c{n}", "touch a", wait=False) for n in range(200)]
    live = Live(tmp_path, {"turns": [[*waiting, {"sleep": 30}], [{"sleep": 30}]]})
    live.send(*START)
    live.until(lambda m: m.get("id") == 199 and "method" in m)
    live.send(INTERRUPT)
    live.until(method("serverRequest/resolved"))
    live.send({"id": 5, "method": "turn/start", "params": {"threadId": "thr_fake", "input": []}})
    live.until(lambda m: m.get("method") == "turn/started" and m["params"]["turn"]["id"] == "turn_2")
    assert "turn/completed" in live.methods()[:-1]
    live.close()


def test_a_codex_that_hangs_on_interrupt_never_answers_it_and_the_turn_runs_on(tmp_path):
    live = Live(tmp_path, {"interrupt_hangs": True, "turns": [[{"sleep": 1}, *fc.agent_message("m1", "done")]]})
    live.send(*START)
    live.until(method("turn/started"))
    live.send(INTERRUPT)
    completed = live.until(method("turn/completed"))
    assert completed["params"]["turn"]["status"] == "completed"
    assert not any(m.get("id") == INTERRUPT["id"] for m in live.out)
    live.close()

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
        *fc.agent_message("m1", "hi"), *fc.command("c1", "ls", output="a"), fc.command_approval(1, "c1", "touch a"),
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

"""The fake Codex app-server: scripted turns over stdio, every message it sends valid against the pinned schema."""

import json
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

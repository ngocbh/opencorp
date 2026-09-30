"""Harness tests that run workspace calls under the OS sandbox."""

import time

import pytest

from tests.chat.conftest import status, wait_for
from tests.sandbox.conftest import sandbox_available  # noqa: F401

pytestmark = pytest.mark.usefixtures("sandbox_available")


def test_esc_kills_a_running_shell_call(harness, fake_llm, workspace):
    fake_llm.script({"tool_calls": [{"name": "shell", "arguments": {"command": "echo started; sleep 60"}}]},
                    {"content": "Next."})
    session = harness.start_session("minh", str(workspace))
    sid = session.id
    wait_for(lambda: status(harness, sid) == "idle", what="the first turn")
    harness.prompt(sid, "run it")
    wait_for(lambda: [p for m in harness.store.list_messages(sid) for p in m.parts
                      if p.type == "tool" and p.state == "running"], what="the shell call")
    time.sleep(0.5)
    began = time.monotonic()
    harness.interrupt(sid)
    wait_for(lambda: status(harness, sid) == "idle", what="the next turn")
    assert time.monotonic() - began < 10
    tool = [p for m in harness.store.list_messages(sid) for p in m.parts if p.type == "tool"][0]
    assert (tool.tool, tool.state) == ("shell", "completed") and "[interrupted]" in tool.output
    assert len(fake_llm.requests()) == 1
    harness.prompt(sid, "again")
    wait_for(lambda: len(fake_llm.requests()) == 2, what="the next turn's model call")


def test_close_all_kills_a_running_shell_call(harness, fake_llm, workspace):
    import subprocess

    fake_llm.script({"tool_calls": [{"name": "shell", "arguments": {"command": "sleep 41.7"}}]}, {"content": "x"})
    session = harness.start_session("minh", str(workspace))
    sid = session.id
    wait_for(lambda: status(harness, sid) == "idle", what="the first turn")
    harness.prompt(sid, "run it")
    wait_for(lambda: [p for m in harness.store.list_messages(sid) for p in m.parts
                      if p.type == "tool" and p.state == "running"], what="the shell call")
    time.sleep(0.5)
    began = time.monotonic()
    harness.close_all()
    assert time.monotonic() - began < 5
    assert harness._calls == 0
    left = subprocess.run(["pgrep", "-f", "sleep 41[.]7"], capture_output=True, text=True).stdout.split()
    assert left == []

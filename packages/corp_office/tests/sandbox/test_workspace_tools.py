import threading
import time

import pytest
from yian.tools import ToolSet

from agent_corp.tools import workspace
from agent_corp.tools.workspace import (
    TOOL_NAMES,
    AuditRecord,
    ToolOutcome,
    WorkspaceTools,
    workspace_tool_functions,
)

pytestmark = pytest.mark.usefixtures("sandbox_available")


@pytest.fixture
def tools(make_policy):
    return WorkspaceTools(make_policy())


def test_file_tools_round_trip(tools, ws):
    assert tools.write_file("pkg/a.py", "x = 1\n").output == "wrote 6 bytes to pkg/a.py"
    assert (ws / "pkg/a.py").read_text() == "x = 1\n"
    assert tools.read_file("pkg/a.py").output == "x = 1\n"
    assert tools.edit_file("pkg/a.py", "x = 1", "x = 2").output == "replaced 1 occurrence in pkg/a.py at line 1"
    assert tools.list_dir(".").output == "pkg/"
    assert tools.search("x = 2").output == "pkg/a.py:1:x = 2"


def test_errors_come_back_as_text(tools):
    out = tools.read_file("missing.txt")
    assert out.output.startswith("error: No such file")
    assert out.audit.exit == 1


def test_large_non_ascii_read(tools, ws):
    # 200k characters of "é" are 1.2 MB as \u00e9 escapes; the reply must still fit.
    (ws / "big.txt").write_text("é" * 300_000)
    out = tools.read_file("big.txt").output
    assert out.startswith("é" * 200_000 + "\n[truncated at 200000 characters")


def test_oversized_reply_is_an_explicit_error(tools, ws, monkeypatch):
    monkeypatch.setattr(workspace, "FILE_OUTPUT_CAP", 1000)
    (ws / "f.txt").write_text("x" * 5000)
    out = tools.read_file("f.txt")
    assert out.output.startswith("error: read_file output too large (over 1000 bytes); ask for less")


def test_shell(tools):
    out = tools.shell("echo hi; echo oops >&2; exit 2")
    assert out.output == "hi\n[stderr]\noops\n[exit 2]"
    assert out.audit.exit == 2


def test_shell_output_keeps_head_and_tail(tools):
    out = tools.shell("echo START; head -c 200000 /dev/zero | tr '\\0' a; echo; echo END >&2").output
    limit = workspace.MAX_SHELL_OUTPUT
    head, note_and_tail = out.split("\n[", 1)
    assert head.startswith("START\n") and len(head.encode()) <= limit // 2
    cut = 6 + 200001 + len("[stderr]\nEND\n") - 2 * (limit // 2)
    assert note_and_tail.startswith(f"{cut} bytes of output cut]\n")
    assert out.endswith("a\n[stderr]\nEND\n[exit 0]")
    assert len(out.encode()) < limit + 100


def test_shell_timeout(tools):
    out = tools.shell("sleep 30", timeout=1)
    assert out.output.endswith("[timed out after 1s]")
    assert out.audit.exit is None


def test_interrupt_kills_a_running_call(tools):
    threading.Timer(0.5, tools.interrupt).start()
    start = time.monotonic()
    out = tools.shell("sleep 30")
    assert out.output.endswith("[interrupted]") and out.audit.exit is None
    assert time.monotonic() - start < 10
    # The next call is unaffected.
    assert tools.shell("echo ok").output == "ok\n[exit 0]"


def test_read_only_workspace(make_policy, ws):
    (ws / "f.txt").write_text("keep")
    tools = WorkspaceTools(make_policy(writable=False))
    assert tools.read_file("f.txt").output == "keep"
    assert tools.write_file("f.txt", "x").output.startswith("error:")
    assert tools.edit_file("f.txt", "keep", "x").output.startswith("error:")
    assert (ws / "f.txt").read_text() == "keep"


def test_every_tool_returns_an_audit_record(tools):
    calls = {
        "write_file": {"path": "f.txt", "content": "y" * 500},
        "read_file": {"path": "f.txt"},
        "edit_file": {"path": "f.txt", "old": "y" * 500, "new": "z"},
        "list": {"path": "."},
        "search": {"pattern": "z"},
        "shell": {"command": "true"},
    }
    assert set(calls) == set(TOOL_NAMES)
    for name, args in calls.items():
        out = tools.call(name, args)
        assert isinstance(out, ToolOutcome) and isinstance(out.audit, AuditRecord)
        assert out.audit.tool == name and out.audit.exit == 0 and out.audit.duration > 0
    summary = tools.call("write_file", calls["write_file"]).audit.args_summary
    assert summary == "path='f.txt' content=<500 chars>"


def test_unknown_tool(tools):
    with pytest.raises(ValueError, match="unknown workspace tool"):
        tools.call("rm", {})


@pytest.mark.parametrize("args, message", [
    ({}, "missing a required argument: 'path'"),
    ({"path": "f.txt", "mode": "x"}, "got an unexpected keyword argument 'mode'"),
])
def test_bad_arguments_come_back_as_text(tools, args, message):
    out = tools.call("read_file", args)
    assert out.output == f"error: read_file: {message}"
    assert out.audit.tool == "read_file" and out.audit.exit is None and out.audit.duration == 0


def test_composer_accepts_the_tool_functions():
    seen = []
    functions = workspace_tool_functions(lambda name, args: seen.append((name, args)) or "ok")
    assert set(functions) == set(TOOL_NAMES)
    toolset = ToolSet(functions)
    schemas = {t.name: set(t.tool_call_schema.model_fields) for t in toolset.resolve(list(TOOL_NAMES))}
    assert schemas == {
        "read_file": {"path", "offset", "limit"},
        "write_file": {"path", "content"},
        "edit_file": {"path", "old", "new", "replace_all"},
        "list": {"path"},
        "search": {"pattern", "path", "glob"},
        "shell": {"command", "timeout"},
    }
    assert all(t.description for t in toolset.resolve(list(TOOL_NAMES)))
    assert toolset.invoke("list", {}) == "ok"
    assert seen == [("list", {"path": "."})]


def test_tool_functions_drive_workspace_tools(tools, ws):
    toolset = ToolSet(workspace_tool_functions(lambda name, args: tools.call(name, args).output))
    assert toolset.invoke("write_file", {"path": "n.txt", "content": "hi"}) == "wrote 2 bytes to n.txt"
    assert toolset.invoke("shell", {"command": "cat n.txt"}) == "hi\n[exit 0]"

import threading
import time

import pytest

from agent_corp.tools.workspace import AuditRecord, ToolOutcome, WorkspaceTools, TOOL_NAMES

pytestmark = pytest.mark.usefixtures("sandbox_available")


@pytest.fixture
def tools(make_policy):
    return WorkspaceTools(make_policy())


def test_file_tools_round_trip(tools, ws):
    assert tools.write_file("pkg/a.py", "x = 1\n").output == "wrote 6 bytes to pkg/a.py"
    assert (ws / "pkg/a.py").read_text() == "x = 1\n"
    assert tools.read_file("pkg/a.py").output == "x = 1\n"
    assert tools.edit_file("pkg/a.py", "x = 1", "x = 2").output == "replaced 1 occurrence in pkg/a.py"
    assert tools.list_dir(".").output == "pkg/"
    assert tools.search("x = 2").output == "pkg/a.py:1:x = 2"


def test_errors_come_back_as_text(tools):
    out = tools.read_file("missing.txt")
    assert out.output.startswith("error: No such file")
    assert out.audit.exit == 1


def test_shell(tools):
    out = tools.shell("echo hi; echo oops >&2; exit 2")
    assert out.output == "hi\n[stderr]\noops\n[exit 2]"
    assert out.audit.exit == 2


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

"""Every workspace call goes through the monitor for its audit row."""

import pytest

from agent_corp.sandbox.policy import SandboxPolicy
from agent_corp.tools.workspace import AuditRecord, ToolOutcome, WorkspaceTools, workspace_tool_functions
from tests.sandbox.conftest import sandbox_available  # noqa: F401


class StubTools:
    def __init__(self, outcome=None, error=None):
        self.outcome, self.error, self.calls = outcome, error, []

    def call(self, name, args):
        self.calls.append((name, args))
        if self.error:
            raise self.error
        return self.outcome


def test_each_call_writes_one_row_and_returns_the_output(make_monitor, store):
    stub = StubTools(ToolOutcome("x = 1\n", AuditRecord("read_file", "path=a.py", 0, 0.012)))
    call = make_monitor().workspace(stub, "minh", "r1", session_id="s1")
    assert workspace_tool_functions(call)["read_file"]("a.py") == "x = 1\n"
    [row] = store.list_audit()
    assert (row.kind, row.tool, row.args, row.outcome, row.detail, row.run_id, row.session_id) == (
        "workspace", "read_file", {"summary": "path=a.py"}, "ok", "exit=0 duration=0.012s", "r1", "s1")


def test_failed_and_killed_calls_are_errors_and_killed_ones_say_why(make_monitor, store):
    m = make_monitor()
    for output, exit_, duration in (
        ("boom\n[exit 1]", 1, 0.1),
        ("partial\n[timed out after 5s]", None, 5),
        ("[interrupted]", None, 0.5),
        ("error: shell: missing a required argument: 'command'", None, 0),
    ):
        stub = StubTools(ToolOutcome(output, AuditRecord("shell", "command=x", exit_, duration)))
        m.workspace(stub, "minh", "r1")("shell", {})
    assert [(r.outcome, r.detail) for r in store.list_audit()] == [
        ("error", "exit=1 duration=0.100s"),
        ("error", "exit=None duration=5.000s: [timed out after 5s]"),
        ("error", "exit=None duration=0.500s: [interrupted]"),
        ("error", "exit=None duration=0.000s: error: shell: missing a required argument: 'command'"),
    ]


def test_a_call_that_raises_is_audited_then_raised(make_monitor, store):
    call = make_monitor().workspace(StubTools(error=OSError("sandbox-exec missing")), "minh", "r1")
    with pytest.raises(OSError):
        call("shell", {"command": "ls"})
    [row] = store.list_audit()
    assert (row.outcome, row.detail) == ("error", "OSError: sandbox-exec missing")


@pytest.mark.usefixtures("sandbox_available")
def test_real_sandboxed_calls_are_audited(make_monitor, store, tmp_path):
    (tmp_path / "ws").mkdir()
    (tmp_path / "tmp").mkdir()
    tools = WorkspaceTools(SandboxPolicy(tmp_path / "ws", True, False, tmp_path / "tmp"))
    fns = workspace_tool_functions(make_monitor().workspace(tools, "minh", "r1"))
    assert fns["write_file"]("a.txt", "hi\n") == "wrote 3 bytes to a.txt"
    assert "hi" in fns["shell"]("cat a.txt")
    assert [(r.tool, r.outcome) for r in store.list_audit()] == [("write_file", "ok"), ("shell", "ok")]

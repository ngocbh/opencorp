"""A Codex session the owner drives: load, turns, steers, interrupts, end, office stop."""

import pytest

from agent_corp.harness.codex import CodexStartError


class Live:
    """What ``CodexSessions.launch`` needs of a session."""

    def __init__(self, session_id, cwd, stopped=False):
        self.session_id, self.cwd, self.stopped, self.launching = session_id, cwd, stopped, None

    def launching_as(self, process):
        if not self.stopped:
            self.launching = process
        return not self.stopped

    def notified(self, *args):
        pass

    requested = exited = notified


def test_launch_registers_the_app_server_before_it_starts_and_refuses_once_stopped(harness, workspace):
    live = Live("S1", str(workspace))
    process = harness.codex.launch(live)
    assert live.launching is process and process.alive
    assert [r.session_id for r in harness.store.list_workers()] == ["harness:S1"]
    process.close(grace=1)
    with pytest.raises(CodexStartError):
        harness.codex.launch(Live("S2", str(workspace), stopped=True))
    assert harness.store.list_workers() == []

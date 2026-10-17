"""Codex that can't start, errors, a dead app-server, an unloaded thread, token counts."""

from agent_corp.harness.sessions import CodexSessions
from agent_corp.worker.spawn import worker_env
from tests.harness.conftest import CODEX_PERSON, errors, status, wait_for


def test_codex_missing_fails_the_session_and_says_what_to_do(make_harness, workspace, tmp_path):
    # Only the app-server's environment lacks codex: the office's own PATH, and its git, stay as they are.
    h = make_harness(files=CODEX_PERSON, codex=lambda office, hooks: CodexSessions(
        office, hooks, env=lambda: {**worker_env(), "PATH": str(tmp_path / "no-codex-here")}))
    sid = h.start_session("minh", str(workspace), "codex").id
    wait_for(lambda: status(h, sid) == "failed", what="failed")
    assert "isn't installed" in errors(h, sid)[0] and h.store.list_workers() == []


def test_a_signed_out_codex_fails_the_session_and_says_to_sign_in(harness, fake_codex, workspace):
    fake_codex.script(account=None)
    sid = harness.start_session("minh", str(workspace), "codex").id
    wait_for(lambda: status(harness, sid) == "failed", what="failed")
    assert "codex login" in errors(harness, sid)[0] and harness.store.list_workers() == []

"""Codex that can't start, errors, a dead app-server, an unloaded thread, token counts."""

from agent_corp.harness.sessions import CodexSessions
from agent_corp.testing import fake_codex as fc
from agent_corp.worker.spawn import worker_env
from tests.harness.conftest import CODEX_PERSON, errors, start, status, wait_for


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


def test_an_error_that_codex_retries_is_only_logged_and_one_it_doesnt_is_shown(harness, fake_codex, workspace):
    fake_codex.script([[fc.error("rate limited, retrying", will_retry=True), fc.error("stream broke", will_retry=False),
                        {"end": "failed", "error": {"message": "usage limit reached"}}]])
    sid = start(harness, workspace)
    harness.prompt(sid, "go")
    wait_for(lambda: status(harness, sid) == "idle" and len(errors(harness, sid)) == 2, what="two errors")
    assert errors(harness, sid) == ["Codex: stream broke", "Codex's turn failed: usage limit reached"]


def test_a_failed_turn_repeating_the_error_shown_shows_it_once(harness, fake_codex, workspace):
    fake_codex.script([[fc.error("usage limit reached", will_retry=False),
                        {"end": "failed", "error": {"message": "usage limit reached"}}]])
    sid = start(harness, workspace)
    harness.prompt(sid, "go")
    wait_for(lambda: status(harness, sid) == "idle" and errors(harness, sid), what="the error")
    assert errors(harness, sid) == ["Codex: usage limit reached"]

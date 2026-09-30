import subprocess

import pytest

from agent_corp.company.git import CompanyGit
from agent_corp.profile import GitProfileStore
from agent_corp.profile.feedback import MAX_ATTEMPTS, FeedbackHandlers, next_status
from tests.company.conftest import _isolate_git, base_files, write_repo  # noqa: F401

SUCCEEDED = {"type": "result", "status": "succeeded", "backward": {"status": "succeeded", "failure": None}}


def failed(code):
    return {"type": "result", "status": "succeeded",
            "backward": {"status": "failed", "failure": {"stage": "commit", "code": code}}}


@pytest.mark.parametrize(("outcome", "committed", "attempts", "expected"), [
    (SUCCEEDED, True, 1, "applied"),
    (SUCCEEDED, False, 1, "applied"),  # the learner kept the text as it was
    (failed("profile.version_mismatch"), False, 1, "retry"),
    (failed("profile.version_mismatch"), False, MAX_ATTEMPTS, "learning_failed"),
    (failed("llm.error"), False, 1, "retry_later"),
    (failed("llm.error"), False, MAX_ATTEMPTS, "learning_failed"),
    (failed("llm.error"), True, 1, "learning_failed"),  # it failed after the office committed
    ({"type": "error", "message": "ValueError: boom"}, False, 1, "retry_later"),
    (None, False, 2, "retry_later"),  # the worker died
    (None, True, 1, "learning_failed"),
])
def test_what_happens_to_feedback_after_an_attempt(outcome, committed, attempts, expected):
    assert next_status(outcome, committed=committed, attempts=attempts) == expected


def test_a_backward_write_is_committed_with_the_feedback_source(tmp_path):
    write_repo(tmp_path / "company", base_files())
    git = CompanyGit(tmp_path / "company", tmp_path / "worktrees")
    store = GitProfileStore(git, "minh")
    text, version = store.read()
    handlers = FeedbackHandlers(stores={"profile": store}, source="from feedback on run r1 (ngocbh)")
    provenance = {"commit_id": "ac-memory-v1:abc", "run_id": "r1", "frame": ["chat"]}
    handlers.store_write(None, "profile", text + "Be brief.\n", version, provenance)
    assert handlers.commit_ids == ["ac-memory-v1:abc"]
    assert handlers.committed() == git.find_commit(store.path, "Commit-Id: ac-memory-v1:abc") is not None
    subject = subprocess.run(["git", "-C", str(git.root), "log", "-1", "--format=%s"], capture_output=True, text=True)
    assert subject.stdout.strip() == "profile(@minh): from feedback on run r1 (ngocbh)"
    assert provenance == {"commit_id": "ac-memory-v1:abc", "run_id": "r1", "frame": ["chat"]}  # not changed


def test_an_attempt_that_wrote_nothing_has_no_commit(tmp_path):
    write_repo(tmp_path / "company", base_files())
    git = CompanyGit(tmp_path / "company", tmp_path / "worktrees")
    handlers = FeedbackHandlers(stores={"profile": GitProfileStore(git, "minh")}, source="s")
    assert handlers.committed() is None
    with pytest.raises(RuntimeError, match="nobody is here"):
        handlers.ask_user(None, {"question": "?"})

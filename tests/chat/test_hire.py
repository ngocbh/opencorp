import subprocess

import pytest

from agent_corp.chat.hire import HireRefused, Hiring
from agent_corp.company.git import CompanyGit
from agent_corp.company.lint import lint
from agent_corp.company.loader import load_repo
from agent_corp.protocol.models import HireRequest
from tests.chat.conftest import CHAT_FLOW
from tests.company.conftest import base_files, write_repo


@pytest.fixture
def git(tmp_path):
    root = write_repo(tmp_path / "company", base_files() | {"shared/flows/chat.yaml": CHAT_FLOW})
    return CompanyGit(root, tmp_path / "worktrees")


FORM = {"name": "Lan", "handle": "lan", "title": "QA", "manager": "ngocbh"}


def test_a_preview_writes_nothing_and_a_confirm_commits(git):
    hiring = Hiring(git)
    head = git.head()
    preview = hiring.hire(HireRequest(**FORM))
    pid = preview.person.id
    assert (preview.commit, preview.issues, git.head()) == (None, [], head)
    assert not (git.root / "people" / pid).exists()
    assert f"+++ b/people/{pid}/person.yaml" in preview.diff and "+handle: lan" in preview.diff

    done = hiring.hire(HireRequest(**FORM, id=pid, confirm=True))
    assert done.commit == git.head() != head and done.person == preview.person
    repo = load_repo(git.root)
    assert repo.people[pid].handle == "lan" and repo.people[pid].main == "../../shared/flows/chat.yaml"
    assert [i for i in lint(repo) if i.severity == "error"] == []


def test_a_new_hire_gets_the_m1_defaults(git):
    hiring = Hiring(git)
    pid = hiring.hire(HireRequest(**FORM)).person.id
    hiring.hire(HireRequest(**FORM, id=pid, confirm=True))
    person = load_repo(git.root).people[pid]
    assert (person.kind, person.harnesses, person.groups, person.skills) == ("agent", ["composer"], [], [])
    assert person.harness_policy.model_dump(exclude_none=True) == {"sandbox": "workspace-write", "network": False}
    assert (git.root / "people" / pid / "profile.md").read_text() == "# Lan, QA\n"
    log = subprocess.run(["git", "-C", str(git.root), "log", "-1", "--format=%s"], capture_output=True, text=True)
    assert log.stdout.strip() == "hire(@lan): Lan, QA"


def test_a_taken_handle_is_the_new_persons_error(git):
    hiring = Hiring(git)
    preview = hiring.hire(HireRequest(**FORM | {"handle": "minh"}))
    pid = preview.person.id
    assert preview.commit is None
    assert (preview.issues[0].path, preview.issues[0].code, preview.issues[0].message) == (
        f"people/{pid}/person.yaml", "person.duplicate_handle", "@minh is already used by minh")
    assert all(i.path != "people/minh/person.yaml" for i in preview.issues)
    with pytest.raises(HireRefused) as err:
        hiring.hire(HireRequest(**FORM | {"handle": "minh"}, id=pid, confirm=True))
    assert (err.value.code, err.value.message) == ("lint_failed", "@minh is already used by minh")
    assert not (git.root / "people" / pid).exists()


def test_a_confirm_must_repeat_the_preview(git):
    hiring = Hiring(git)
    head = git.head()
    pid = hiring.hire(HireRequest(**FORM)).person.id
    with pytest.raises(HireRefused) as err:
        hiring.hire(HireRequest(**FORM | {"title": "Lead QA"}, id=pid, confirm=True))
    assert err.value.code == "lint_failed"
    with pytest.raises(HireRefused) as err:
        hiring.hire(HireRequest(**FORM, confirm=True))
    assert err.value.code == "invalid_body"
    assert git.head() == head


def test_an_unknown_manager_is_a_lint_error(git):
    preview = Hiring(git).hire(HireRequest(**FORM | {"manager": "kai"}))
    assert any(i.severity == "error" and "kai" in i.message for i in preview.issues)


def test_a_failed_commit_leaves_nothing_behind_and_a_retry_succeeds(git, monkeypatch):
    hiring = Hiring(git)
    head = git.head()
    pid = hiring.hire(HireRequest(**FORM)).person.id

    def broken(paths, message):
        raise OSError("disk full")
    monkeypatch.setattr(git, "commit", broken)
    with pytest.raises(OSError):
        hiring.hire(HireRequest(**FORM, id=pid, confirm=True))
    assert not (git.root / "people" / pid).exists()
    status = subprocess.run(["git", "-C", str(git.root), "status", "--porcelain"], capture_output=True, text=True)
    assert (status.stdout, git.head()) == ("", head)

    monkeypatch.undo()
    assert git.commit_hand_edits() == []  # nothing left over to sweep up as a hand edit
    done = hiring.hire(HireRequest(**FORM, id=pid, confirm=True))
    assert done.commit == git.head() != head

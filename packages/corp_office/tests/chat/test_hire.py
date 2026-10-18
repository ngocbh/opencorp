import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from opencorp.chat.hire import HireRefused, Hiring, agent_files
from opencorp.company.git import CompanyGit
from opencorp.company.lint import lint
from opencorp.company.loader import load_repo
from opencorp.protocol.models import HireRequest
from tests.chat.conftest import CHAT_FLOW
from tests.company.conftest import _git, base_files, person, write_repo


@pytest.fixture
def git(tmp_path):
    root = write_repo(tmp_path / "company", base_files() | {"shared/flows/chat.yaml": CHAT_FLOW})
    return CompanyGit(root, tmp_path / "worktrees")


FORM = {"name": "Lan", "handle": "lan", "title": "QA", "manager": "ngocbh"}


def test_a_preview_writes_nothing_and_a_confirm_commits(git):
    hiring = Hiring(git)
    head = git.head()
    preview = hiring.hire(HireRequest(**FORM))
    assert (preview.commit, preview.issues, git.head()) == (None, [], head)
    assert not (git.root / "people/lan").exists()
    assert "+++ b/people/lan/person.yaml" in preview.diff and "+handle: lan" in preview.diff

    done = hiring.hire(HireRequest(**FORM, confirm=True))
    assert done.commit == git.head() != head and done.person == preview.person
    assert sorted(p.name for p in (git.root / "people/lan").iterdir()) == ["person.yaml", "profile.md"]
    repo = load_repo(git.root)
    assert repo.people["lan"].handle == "lan" and repo.people["lan"].main == "../../shared/flows/chat.yaml"
    assert [i for i in lint(repo) if i.severity == "error"] == []


def test_a_new_hire_gets_the_m1_defaults(git):
    hiring = Hiring(git)
    hiring.hire(HireRequest(**FORM))
    hiring.hire(HireRequest(**FORM, confirm=True))
    person = load_repo(git.root).people["lan"]
    assert (person.kind, person.harnesses, person.groups, person.skills) == ("agent", ["composer"], [], [])
    assert person.harness_policy.model_dump(exclude_none=True) == {"sandbox": "workspace-write", "network": False}
    assert (git.root / "people/lan/profile.md").read_text() == "# Lan, QA\n"
    log = subprocess.run(["git", "-C", str(git.root), "log", "-1", "--format=%s"], capture_output=True, text=True)
    assert log.stdout.strip() == "hire(@lan): Lan, QA"


def test_agent_files_are_a_hires_files_with_an_optional_line_about_the_work(git):
    hiring = Hiring(git)
    hiring.hire(HireRequest(**FORM))
    hiring.hire(HireRequest(**FORM, confirm=True))
    person, files = agent_files(HireRequest(**FORM))
    assert person == load_repo(git.root).people["lan"]
    assert files == {rel: (git.root / rel).read_text() for rel in ("people/lan/person.yaml", "people/lan/profile.md")}
    assert agent_files(HireRequest(**FORM), "Tests every release.")[1]["people/lan/profile.md"] == (
        "# Lan, QA\n\nTests every release.\n")


def test_a_taken_handle_is_refused_and_names_the_clash(git):
    hiring = Hiring(git)
    head = git.head()
    minh = (git.root / "people/minh/person.yaml").read_text()
    preview = hiring.hire(HireRequest(**FORM | {"handle": "minh"}))
    assert preview.commit is None
    assert [(i.path, i.code, i.message, i.severity) for i in preview.issues] == [
        ("people/minh/person.yaml", "person.duplicate_handle", "@minh is already taken", "error")]
    with pytest.raises(HireRefused) as err:
        hiring.hire(HireRequest(**FORM | {"handle": "minh"}, confirm=True))
    assert (err.value.code, err.value.message) == ("lint_failed", "@minh is already taken")
    assert (git.head(), (git.root / "people/minh/person.yaml").read_text()) == (head, minh)


def test_a_folder_left_by_hand_takes_the_handle(git):
    (git.root / "people/lan").mkdir()
    preview = Hiring(git).hire(HireRequest(**FORM))
    assert [i.code for i in preview.issues] == ["person.duplicate_handle"]


def test_a_confirm_must_repeat_the_preview(git):
    hiring = Hiring(git)
    head = git.head()
    with pytest.raises(HireRefused) as err:
        hiring.hire(HireRequest(**FORM, confirm=True))  # never previewed
    assert err.value.code == "lint_failed"
    hiring.hire(HireRequest(**FORM))
    with pytest.raises(HireRefused) as err:
        hiring.hire(HireRequest(**FORM | {"title": "Lead QA"}, confirm=True))
    assert err.value.code == "lint_failed"
    assert git.head() == head


def test_an_unknown_manager_is_a_lint_error(git):
    preview = Hiring(git).hire(HireRequest(**FORM | {"manager": "kai"}))
    assert any(i.severity == "error" and "kai" in i.message for i in preview.issues)


def test_a_failed_commit_leaves_nothing_behind_and_a_retry_succeeds(git, monkeypatch):
    hiring = Hiring(git)
    head = git.head()
    hiring.hire(HireRequest(**FORM))

    def broken(paths, message):
        raise OSError("disk full")
    monkeypatch.setattr(git, "commit", broken)
    with pytest.raises(OSError):
        hiring.hire(HireRequest(**FORM, confirm=True))
    assert not (git.root / "people/lan").exists()
    status = subprocess.run(["git", "-C", str(git.root), "status", "--porcelain"], capture_output=True, text=True)
    assert (status.stdout, git.head()) == ("", head)

    monkeypatch.undo()
    assert git.commit_hand_edits() == []  # nothing left over to sweep up as a hand edit
    done = hiring.hire(HireRequest(**FORM, confirm=True))
    assert done.commit == git.head() != head


def test_a_newline_in_the_title_cant_forge_a_commit_trailer(git):
    hiring = Hiring(git)
    form = FORM | {"title": "QA\n\nCommit-Id: forged"}
    hiring.hire(HireRequest(**form))
    hiring.hire(HireRequest(**form, confirm=True))
    log = subprocess.run(["git", "-C", str(git.root), "log", "-1", "--format=%B"], capture_output=True, text=True)
    assert log.stdout.strip() == "hire(@lan): Lan, QA Commit-Id: forged"


def test_an_existing_lint_error_is_a_warning_and_doesnt_block_a_hire(tmp_path):
    files = base_files() | {"shared/flows/chat.yaml": CHAT_FLOW,
                            "people/minh/person.yaml": person("minh", manager="kai")}
    git = CompanyGit(write_repo(tmp_path / "company", files), tmp_path / "worktrees")
    hiring = Hiring(git)
    preview = hiring.hire(HireRequest(**FORM))
    old = [i for i in preview.issues if i.path == "people/minh/person.yaml"]
    assert old and {i.severity for i in old} == {"warning"}
    assert all(i.severity == "warning" for i in preview.issues)
    done = hiring.hire(HireRequest(**FORM, confirm=True))
    assert done.commit == git.head()

    bad = hiring.hire(HireRequest(**FORM | {"handle": "kai-fan", "manager": "kai"}))  # the same error, new
    assert any(i.severity == "error" and i.path.startswith("people/kai-fan/") for i in bad.issues)
    with pytest.raises(HireRefused):
        hiring.hire(HireRequest(**FORM | {"handle": "kai-fan", "manager": "kai"}, confirm=True))


def test_old_previews_are_dropped_past_the_cap(git):
    hiring = Hiring(git, max_previews=2)
    forms = [FORM | {"handle": handle} for handle in ("lan", "kai", "ava")]
    for form in forms:
        hiring.hire(HireRequest(**form))
    with pytest.raises(HireRefused) as err:
        hiring.hire(HireRequest(**forms[0], confirm=True))
    assert err.value.code == "lint_failed"
    assert hiring.hire(HireRequest(**forms[2], confirm=True)).commit == git.head()


def test_a_new_preview_of_a_handle_replaces_the_old_one(git):
    hiring = Hiring(git)
    hiring.hire(HireRequest(**FORM))
    hiring.hire(HireRequest(**FORM | {"title": "Lead QA"}))
    with pytest.raises(HireRefused):
        hiring.hire(HireRequest(**FORM, confirm=True))
    assert hiring.hire(HireRequest(**FORM | {"title": "Lead QA"}, confirm=True)).commit == git.head()


def test_a_preview_leaves_hand_edits_alone(git):
    (git.root / "people/minh/profile.md").write_text("# Minh, Engineer\n\nLikes tests.\n")
    head = git.head()
    Hiring(git).hire(HireRequest(**FORM))
    status = subprocess.run(["git", "-C", str(git.root), "status", "--porcelain"], capture_output=True, text=True)
    assert (git.head(), status.stdout) == (head, " M people/minh/profile.md\n")


def test_a_hire_is_never_written_outside_the_repo(tmp_path):
    root = tmp_path / "company"
    write_repo(root, base_files() | {"shared/flows/chat.yaml": CHAT_FLOW})
    outside = tmp_path / "outside"
    (root / "people").rename(outside)
    (root / "people").symlink_to(outside)
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "people elsewhere")
    git = CompanyGit(root, tmp_path / "worktrees")
    hiring = Hiring(git)
    preview = hiring.hire(HireRequest(**FORM))
    assert [(i.code, i.severity) for i in preview.issues] == [("person.outside_repo", "error")]
    with pytest.raises(HireRefused) as err:
        hiring.hire(HireRequest(**FORM, confirm=True))
    assert err.value.code == "lint_failed"
    assert not (outside / "lan").exists()


def test_concurrent_confirms_commit_a_hire_once(git):
    hiring = Hiring(git)
    head = git.head()
    hiring.hire(HireRequest(**FORM))
    hiring.hire(HireRequest(**FORM | {"handle": "kai-fan"}))
    start = threading.Barrier(3)

    def confirm(form):
        start.wait()
        try:
            return hiring.hire(HireRequest(**form, confirm=True)).commit
        except HireRefused as exc:
            return exc.code

    with ThreadPoolExecutor(3) as pool:
        results = list(pool.map(confirm, [FORM, FORM, FORM | {"handle": "kai-fan"}]))
    assert results[:2].count("lint_failed") == 1 and results[2] != "lint_failed"  # one of the same two lost
    commits = subprocess.run(["git", "-C", str(git.root), "log", "--format=%s", f"{head}..HEAD"],
                             capture_output=True, text=True).stdout.split("\n")[:-1]
    assert sorted(commits) == ["hire(@kai-fan): Lan, QA", "hire(@lan): Lan, QA"]
    assert set(load_repo(git.root).people) >= {"lan", "kai-fan"}

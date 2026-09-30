"""GitProfileStore: profile.md in the company clone as a MarkdownStore versioned by git blob id."""

import pytest

from agent_corp.company.git import CompanyGit
from agent_corp.profile import EMPTY_BLOB, GitProfileStore, blob_id
from tests.company.conftest import _git, _isolate_git, company  # noqa: F401

PROFILE = "people/minh/profile.md"
MINH = "# Minh, Engineer\n"


@pytest.fixture
def git(company, tmp_path):
    return CompanyGit(company, tmp_path / "worktrees")


@pytest.fixture
def store(git):
    return GitProfileStore(git, "minh")


def _subject(company) -> str:
    return _git(company, "log", "-1", "--format=%s")


# Reads


def test_constructor_does_no_io(tmp_path):
    GitProfileStore(CompanyGit(tmp_path / "missing", tmp_path / "worktrees"), "minh")


@pytest.mark.parametrize("pid", ["", "../minh", "minh/x", "Minh", "a_b", "a--b", "a" * 65])
def test_constructor_refuses_a_bad_person_id(git, pid):
    with pytest.raises(ValueError, match="not a person id"):
        GitProfileStore(git, pid)


def test_read_returns_text_and_blob_id(store, git):
    assert store.read() == (MINH, blob_id(MINH.encode()))
    assert store.read()[1] == git.blob_id(PROFILE)


def test_read_commits_a_pending_hand_edit_first(store, git, company):
    (company / PROFILE).write_text("# Minh\nlikes tests\n")
    text, version = store.read()
    assert text == "# Minh\nlikes tests\n" and version == git.blob_id(PROFILE)
    assert _subject(company) == "profile(@minh): hand edit"
    assert _git(company, "status", "--porcelain") == ""


def test_read_keeps_crlf(store, company):
    (company / PROFILE).write_bytes(b"# Minh\r\n")
    assert store.read() == ("# Minh\r\n", blob_id(b"# Minh\r\n"))


def test_named_version_reads_old_text(store, git, company):
    old = store.read()[1]
    (company / PROFILE).write_text("# Minh\nnew\n")
    git.commit([PROFILE], "edit")
    assert store.read(old) == (MINH, old)


@pytest.mark.parametrize("version", ["0" * 40, "HEAD", "HEAD:company.yaml", "sha256:" + "0" * 64])
def test_unknown_version_raises_lookup_error(store, version):
    with pytest.raises(LookupError):
        store.read(version)


def test_missing_profile_reads_as_empty(store, company):
    _git(company, "rm", "-q", PROFILE)
    _git(company, "commit", "-q", "-m", "drop")
    assert store.read() == ("", EMPTY_BLOB)
    assert store.read(EMPTY_BLOB) == ("", EMPTY_BLOB)


def test_non_utf8_profile_is_a_value_error(store, company):
    (company / PROFILE).write_bytes(b"# M\xffinh\n")
    with pytest.raises(ValueError):
        store.read()


def test_git_failure_is_an_os_error(tmp_path):
    (tmp_path / "not-a-repo").mkdir()
    store = GitProfileStore(CompanyGit(tmp_path / "not-a-repo", tmp_path / "worktrees"), "minh")
    with pytest.raises(OSError, match="exited"):
        store.read()

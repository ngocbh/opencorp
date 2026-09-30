"""GitProfileStore: profile.md in the company clone as a MarkdownStore versioned by git blob id."""

import os
import threading

import agent_composer.memory.profile as composer_profile
import pytest
from agent_composer.memory import LearnContext, MemoryFrameRef, MemoryFrameSpec, MemoryOwner
from agent_composer.memory.profile import ProfileMemory
from agent_composer.memory.storage.markdown import MarkdownStore, MarkdownVersionMismatch
from langchain_core.messages import AIMessage

from agent_corp.company.git import CompanyGit, CompanyGitError
from agent_corp.profile import EMPTY_BLOB, GitProfileStore, blob_id, commit_message
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


def _count(company) -> int:
    return int(_git(company, "rev-list", "--count", "HEAD"))


# Writes


def test_write_commits_with_the_provenance_message(store, git, company):
    base = store.read()[1]
    version = store.write("# Minh\nterse\n", base_version=base, provenance={"source": "ngocbh via profile manager"})
    assert version == blob_id(b"# Minh\nterse\n") == git.blob_id(PROFILE)
    assert (company / PROFILE).read_text() == "# Minh\nterse\n"
    assert _subject(company) == "profile(@minh): ngocbh via profile manager"
    assert _git(company, "status", "--porcelain") == ""


def test_stale_base_raises_with_both_versions_and_writes_nothing(store, company):
    stale = blob_id(b"old\n")
    head = _git(company, "rev-parse", "HEAD")
    with pytest.raises(MarkdownVersionMismatch) as caught:
        store.write("x\n", base_version=stale)
    assert (caught.value.expected, caught.value.current) == (stale, blob_id(MINH.encode()))
    assert (company / PROFILE).read_text() == MINH and _git(company, "rev-parse", "HEAD") == head


def test_a_hand_edit_makes_the_base_stale(store, company):
    base = store.read()[1]
    (company / PROFILE).write_text("# Minh\nby hand\n")
    with pytest.raises(MarkdownVersionMismatch) as caught:
        store.write("# Minh\nby model\n", base_version=base)
    assert caught.value.current == blob_id(b"# Minh\nby hand\n")
    assert (company / PROFILE).read_text() == "# Minh\nby hand\n"
    assert _subject(company) == "profile(@minh): hand edit"


def test_write_with_the_empty_base_creates_a_missing_profile(store, git, company):
    _git(company, "rm", "-q", PROFILE)
    _git(company, "commit", "-q", "-m", "drop")
    version = store.write("# Minh\n", base_version=EMPTY_BLOB)
    assert version == git.blob_id(PROFILE) == blob_id(b"# Minh\n")


def test_unchanged_text_makes_no_commit(store, company):
    base = store.read()[1]
    before = _count(company)
    assert store.write(MINH, base_version=base) == base
    assert _count(company) == before


def test_write_refuses_a_symlinked_profile(store, company, tmp_path):
    outside = tmp_path / "outside.md"
    outside.write_text(MINH)
    (company / PROFILE).unlink()
    os.symlink(outside, company / PROFILE)
    base = store.read()[1]  # the symlink, committed as a hand edit
    with pytest.raises(ValueError, match="symlink"):
        store.write("pwned\n", base_version=base)
    assert outside.read_text() == MINH


def test_write_refuses_non_strings(store):
    with pytest.raises(TypeError):
        store.write(b"x", base_version=store.read()[1])


def test_commit_message_sources():
    assert commit_message("minh", None) == "profile(@minh): write"
    assert commit_message("minh", {"source": "hand edit"}) == "profile(@minh): hand edit"
    assert commit_message("minh", {"run_id": "01J", "commit_id": "ac-memory-v1:ab"}) == (
        "profile(@minh): from feedback on run 01J\n\nCommit-Id: ac-memory-v1:ab")
    assert commit_message("minh", {"source": "a\nb  c", "run_id": "01J"}) == "profile(@minh): a b c"


@pytest.mark.parametrize("commit_id", ["", "a b", "a\nCommit-Id: b", 7])
def test_bad_commit_id_is_a_value_error(store, commit_id):
    with pytest.raises(ValueError, match="commit_id"):
        store.write("x\n", base_version=store.read()[1], provenance={"commit_id": commit_id})


# Concurrency, pins, and composer's ProfileMemory


def test_two_threads_with_one_base_one_wins(git, company):
    base = GitProfileStore(git, "minh").read()[1]
    barrier, results = threading.Barrier(2), []

    def write(text):
        barrier.wait()
        try:
            results.append(GitProfileStore(git, "minh").write(text, base_version=base))
        except MarkdownVersionMismatch as exc:
            results.append(exc)

    threads = [threading.Thread(target=write, args=(f"# Minh\n{n}\n",)) for n in "ab"]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(type(r).__name__ for r in results) == ["MarkdownVersionMismatch", "str"]
    assert GitProfileStore(git, "minh").read()[1] in results


def test_writes_leave_pinned_worktrees_alone(store, git):
    pin = git.pin("HEAD")
    store.write("# Minh\nnew\n", base_version=store.read()[1])
    assert (pin / PROFILE).read_text() == MINH


ROOT = MemoryFrameRef("chat", ("chat",), MemoryOwner.FLOW)


def test_profile_memory_restores_a_snapshot_after_a_later_write(store):
    assert isinstance(store, MarkdownStore)
    memory = ProfileMemory(store, llm_config={"provider": "ollama", "model": "stub"})
    with memory.open_run() as session:
        recorded = session.snapshot
    store.write("# Minh\nlater\n", base_version=store.read()[1])
    with memory.open_run(snapshot=recorded) as restored:
        assert restored.snapshot == recorded
        assert restored.open_frame(MemoryFrameSpec(ROOT, "profile", {})).recall() == MINH


def test_write_keeps_the_file_mode(store, company):
    (company / PROFILE).chmod(0o644)
    store.write("# Minh\nnew\n", base_version=store.read()[1])
    assert (company / PROFILE).stat().st_mode & 0o777 == 0o644


# Retried writes


def test_same_commit_id_twice_makes_one_commit(store, company):
    base = store.read()[1]
    first = store.write("# Minh\nv1\n", base_version=base, provenance={"commit_id": "c-1"})
    count = _count(company)
    assert store.write("# Minh\nv1\n", base_version=base, provenance={"commit_id": "c-1"}) == first
    assert _count(company) == count
    assert store.committed("c-1") == first and store.committed("c-2") is None


def test_retry_after_a_later_write_returns_its_own_version(store, company):
    base = store.read()[1]
    first = store.write("# Minh\nv1\n", base_version=base, provenance={"commit_id": "c-1"})
    store.write("# Minh\nv2\n", base_version=first)
    assert store.write("# Minh\nv1\n", base_version=base, provenance={"commit_id": "c-1"}) == first
    assert (company / PROFILE).read_text() == "# Minh\nv2\n"


def test_commit_ids_are_per_profile(git, company):
    minh, boss = GitProfileStore(git, "minh"), GitProfileStore(git, "ngocbh")
    minh.write("# Minh\nv1\n", base_version=minh.read()[1], provenance={"commit_id": "c-1"})
    assert boss.committed("c-1") is None


FEEDBACK = ({"channel": "output", "target_name": None, "value": "Be terse.",
             "owner_static_path": None, "execution_seq": None},)


def test_profile_memory_commit_is_a_git_commit_with_run_and_commit_id(store, company, monkeypatch):
    class Learner:
        def invoke(self, messages):
            return AIMessage(content="<profile># Minh\nTerse.</profile>")

    monkeypatch.setattr(composer_profile, "model_from_config", lambda config: Learner())
    memory = ProfileMemory(store, llm_config={"provider": "ollama", "model": "stub"})
    with memory.open_run() as session:
        root = session.open_frame(MemoryFrameSpec(ROOT, "profile", {}))
        session.commit("ac-memory-v1:abc", tuple(root.learn(LearnContext("run-1", ROOT, (), FEEDBACK))))
    assert store.read()[0] == "# Minh\nTerse.\n"
    assert _git(company, "log", "-1", "--format=%B") == (
        "profile(@minh): from feedback on run run-1\n\nCommit-Id: ac-memory-v1:abc")
    assert store.committed("ac-memory-v1:abc") == store.read()[1]


# Failed commits


def _failing_commit(company):
    """A ``CompanyGit.commit`` that stages the path, then fails as a stale index.lock would."""
    def commit(paths, message):
        _git(company, "add", "--", *paths)
        raise CompanyGitError("git commit exited 128: fatal: Unable to create '.git/index.lock'")
    return commit


def test_a_failed_commit_restores_the_profile(store, git, company, monkeypatch):
    base = store.read()[1]
    monkeypatch.setattr(git, "commit", _failing_commit(company))
    with pytest.raises(OSError, match="index.lock"):
        store.write("# Minh\nv1\n", base_version=base, provenance={"commit_id": "c-1"})
    monkeypatch.undo()
    assert (company / PROFILE).read_text() == MINH
    assert _git(company, "status", "--porcelain") == ""
    assert store.committed("c-1") is None
    assert store.write("# Minh\nv1\n", base_version=base, provenance={"commit_id": "c-1"}) == (
        blob_id(b"# Minh\nv1\n"))
    assert store.committed("c-1") == blob_id(b"# Minh\nv1\n")


def test_a_failed_commit_removes_a_new_profile(store, git, company, monkeypatch):
    _git(company, "rm", "-q", PROFILE)
    _git(company, "commit", "-q", "-m", "drop")
    monkeypatch.setattr(git, "commit", _failing_commit(company))
    with pytest.raises(OSError):
        store.write("# Minh\n", base_version=EMPTY_BLOB)
    assert not (company / PROFILE).exists()
    assert _git(company, "status", "--porcelain") == ""

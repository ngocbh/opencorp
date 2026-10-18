import os
import stat
import subprocess
import threading
import time

import pytest

from opencorp.company.git import CompanyGit, CompanyGitError
from tests.company.conftest import _git, write_repo

PROFILE = "people/minh/profile.md"
OFFICE = "OpenCorp office <office@opencorp.local>"


@pytest.fixture
def g(company, tmp_path):
    return CompanyGit(company, tmp_path / "worktrees")


def test_git_never_reads_the_daemons_stdin(g, monkeypatch):
    # Under tmux the daemon's stdin is the pane, and a git that read it would block holding the lock.
    run, calls = subprocess.run, []

    def recording(*args, **kwargs):
        calls.append(kwargs)
        return run(*args, **kwargs)

    monkeypatch.setattr(subprocess, "run", recording)
    g.read_blob(g.blob_id(PROFILE))
    g.read_blobs([g.blob_id(PROFILE)])
    assert len(calls) == 4
    assert all(c.get("stdin") == subprocess.DEVNULL or "input" in c for c in calls)


def test_blob_id_ignores_other_files(g, company):
    before = g.blob_id(PROFILE)
    (company / "groups/eng.yaml").write_text("id: eng\nname: Eng\nparent: null\nhead: null\n")
    g.commit(["groups/eng.yaml"], "edit group")
    assert g.blob_id(PROFILE) == before
    assert g.blob_id("people/nobody/profile.md") is None


def test_read_head_follows_loose_and_packed_refs_and_a_detached_head(g, company):
    assert g.read_head() == g.head()
    (company / "groups/eng.yaml").write_text("id: eng\nname: Eng\nparent: null\nhead: null\n")
    g.commit(["groups/eng.yaml"], "edit group")
    assert g.read_head() == g.head()
    _git(company, "pack-refs", "--all")
    assert not (company / ".git/refs/heads/main").exists()
    assert g.read_head() == g.head()
    _git(company, "checkout", "-q", "--detach", "HEAD~1")
    assert g.read_head() == g.head() == _git(company, "rev-parse", "HEAD")


def test_read_head_with_no_commit_is_a_value_error(tmp_path):
    _git(tmp_path, "init", "-q", "-b", "main")
    with pytest.raises(ValueError):
        CompanyGit(tmp_path, tmp_path / "wt").read_head()


def test_files_lists_blobs_under_a_folder_at_a_commit(g, company):
    head = g.head()
    (company / "people/ava").mkdir()
    (company / "people/ava/person.yaml").write_text("handle: ava\n")
    g.commit(["people/ava/person.yaml"], "add ava")
    at_head = g.files("people", head)
    assert sorted(at_head) == ["people/minh/person.yaml", "people/minh/profile.md", "people/ngocbh/person.yaml"]
    assert at_head["people/minh/profile.md"] == g.blob_id("people/minh/profile.md")
    assert "people/ava/person.yaml" in g.files("people")
    assert g.files("nowhere") == {}


def test_read_blobs_reads_several_at_once_and_skips_what_it_cant(g, company):
    profile, person = g.blob_id(PROFILE), g.blob_id("people/minh/person.yaml")
    (company / PROFILE).write_bytes(b"# Minh\r\n\n")
    g.commit([PROFILE], "crlf")
    crlf = g.blob_id(PROFILE)
    found = g.read_blobs([profile, g.head(), crlf, "0" * 40, person, "HEAD:company.yaml", profile])
    assert found == {profile: g.read_blob(profile), crlf: b"# Minh\r\n\n", person: g.read_blob(person)}
    assert g.read_blobs([]) == {}


def test_commit_with_no_change_returns_head(g, company):
    head = g.head()
    (company / PROFILE).write_text("# Minh, Engineer\n")  # same text
    assert g.commit([PROFILE], "no-op") == head


def test_lock_serializes_writers(g, company):
    def write(line):
        with g.lock:
            text = (company / PROFILE).read_text()
            time.sleep(0.05)
            (company / PROFILE).write_text(text + line + "\n")
            g.commit([PROFILE], f"add {line}")

    threads = [threading.Thread(target=write, args=(x,)) for x in ("a", "b")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted((company / PROFILE).read_text().splitlines()[1:]) == ["a", "b"]
    assert len(_git(company, "log", "--format=%s").splitlines()) == 3


def test_pin_is_frozen_at_its_commit(g, company):
    commit = g.head()
    pinned = g.pin(commit)
    (company / PROFILE).write_text("# changed\n")
    g.commit([PROFILE], "profile(@minh): test")
    assert (pinned / PROFILE).read_text() == "# Minh, Engineer\n"
    assert g.pin(commit) == pinned  # cached


def test_pin_is_read_only(g):
    mode = os.stat(g.pin(g.head()) / "shared/flows/chat.yaml").st_mode
    assert not mode & (stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH)


def test_pin_keys_by_full_sha(g):
    assert g.pin("HEAD").name == g.head() == g.pin("main").name


def test_pin_unknown_commit_raises(g):
    with pytest.raises(ValueError):
        g.pin("0" * 40)


def test_pin_rebuilds_a_deleted_dir(g):
    import shutil
    pinned = g.pin("HEAD")
    shutil.rmtree(pinned)
    assert (g.pin("HEAD") / PROFILE).is_file()


def test_pin_rebuilds_a_dir_without_marker(g):
    pinned = g.pin("HEAD")
    (pinned / ".opencorp-pin").unlink()
    (pinned / PROFILE).chmod(0o644)  # as if the crash came before chmod
    pinned = g.pin("HEAD")
    assert not os.stat(pinned / PROFILE).st_mode & stat.S_IWUSR


def test_pin_leaves_symlink_targets_alone(g, company, tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_text("mine\n")
    (company / "link.txt").symlink_to(outside)
    g.commit(["link.txt"], "add link")
    g.pin("HEAD")
    assert os.stat(outside).st_mode & stat.S_IWUSR


def test_hand_edit_is_committed_with_handle(g, company):
    (company / PROFILE).write_text("# Minh\nlikes tests\n")
    assert g.commit_hand_edits() == [PROFILE]
    assert _git(company, "log", "-1", "--format=%s") == "profile(@minh): hand edit"
    assert _git(company, "status", "--porcelain") == ""


def test_other_dirty_files_stay_dirty(g, company):
    (company / "groups/eng.yaml").write_text("id: eng\nname: Eng\nparent: null\nhead: null\n")
    assert g.commit_hand_edits() == []
    assert _git(company, "status", "--porcelain") == "M groups/eng.yaml"


def test_new_profile_is_committed(g, company):
    (company / "people/ava").mkdir()
    (company / "people/ava/person.yaml").write_text("handle: ava\n")
    (company / "people/ava/profile.md").write_text("# Ava\n")
    assert g.commit_hand_edits() == ["people/ava/profile.md"]
    assert _git(company, "log", "-1", "--format=%s") == "profile(@ava): hand edit"
    assert _git(company, "status", "--porcelain") == "?? people/ava/person.yaml"


def test_deleted_profile_is_committed(g, company):
    (company / PROFILE).unlink()
    assert g.commit_hand_edits() == [PROFILE]
    assert _git(company, "log", "-1", "--format=%s") == "profile(@minh): hand edit"
    assert _git(company, "status", "--porcelain") == ""


def test_staged_rename_commits_both_paths(g, company):
    _git(company, "mv", PROFILE, "people/ngocbh/profile.md")
    assert g.commit_hand_edits() == [PROFILE, "people/ngocbh/profile.md"]
    assert _git(company, "status", "--porcelain") == ""
    assert g.blob_id(PROFILE) is None and g.blob_id("people/ngocbh/profile.md") is not None


def test_git_dir_in_the_environment_is_ignored(g, company, tmp_path, monkeypatch):
    other = write_repo(tmp_path / "other", {"x.txt": "x\n"})
    head = g.head()
    monkeypatch.setenv("GIT_DIR", str(other / ".git"))
    monkeypatch.setenv("GIT_WORK_TREE", str(other))
    assert g.head() == head
    (company / PROFILE).write_text("# edited\n")
    g.commit([PROFILE], "edit")
    assert _git(company, "log", "-1", "--format=%s") == "edit"


def test_author_env_does_not_override_the_office(g, company, monkeypatch):
    for var in ("GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"):
        monkeypatch.setenv(var, "leaked")
    (company / PROFILE).write_text("# edited\n")
    g.commit([PROFILE], "edit")
    assert _git(company, "log", "-1", "--format=%an <%ae>|%cn <%ce>") == f"{OFFICE}|{OFFICE}"


def test_user_git_config_is_ignored(g, company, tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    (home / ".gitconfig").write_text("[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("GIT_CONFIG_GLOBAL")
    monkeypatch.delenv("GIT_CONFIG_NOSYSTEM")
    (company / PROFILE).write_text("# edited\n")
    g.commit([PROFILE], "edit")
    assert _git(company, "log", "-1", "--format=%s") == "edit"


def test_repo_signing_config_is_ignored(g, company):
    _git(company, "config", "commit.gpgsign", "true")
    _git(company, "config", "gpg.program", "false")
    (company / PROFILE).write_text("# edited\n")
    g.commit([PROFILE], "edit")
    assert _git(company, "log", "-1", "--format=%s") == "edit"


def _failing_hook(repo, name):
    hook = repo / ".git/hooks" / name
    hook.write_text("#!/bin/sh\necho refused >&2\nexit 1\n")
    hook.chmod(0o755)


def test_repo_hooks_do_not_run(g, company):
    for name in ("pre-commit", "commit-msg", "post-checkout"):
        _failing_hook(company, name)
    (company / PROFILE).write_text("# edited\n")
    g.commit([PROFILE], "edit")
    assert _git(company, "log", "-1", "--format=%s") == "edit"
    assert (g.pin("HEAD") / PROFILE).read_text() == "# edited\n"


def test_git_failure_carries_stderr(g, tmp_path):
    (tmp_path / "outside.txt").write_text("x\n")
    with pytest.raises(CompanyGitError, match="outside repository"):
        g.commit(["../outside.txt"], "edit")


def test_worktree_rename_commits_both_paths(g, company):
    (company / "people/ava").mkdir()
    (company / PROFILE).rename(company / "people/ava/profile.md")
    _git(company, "add", "-N", "people/ava/profile.md")  # status now reports " R new\0old"
    assert g.commit_hand_edits() == ["people/ava/profile.md", PROFILE]
    assert _git(company, "status", "--porcelain") == ""
    assert g.blob_id(PROFILE) is None and g.blob_id("people/ava/profile.md") is not None


def test_glob_characters_in_paths_are_literal(g, company):
    odd = "people/[mn]inh/profile.md"
    (company / "people/[mn]inh").mkdir()
    (company / odd).write_text("# odd\n")
    (company / PROFILE).write_text("# edited\n")
    g.commit([odd], "odd")
    assert _git(company, "show", "--name-only", "--format=", "HEAD") == odd
    assert _git(company, "status", "--porcelain") == f"M {PROFILE}"
    assert g.commit_hand_edits() == [PROFILE]
    assert _git(company, "show", "--name-only", "--format=", "HEAD") == PROFILE


def test_commit_of_no_paths_is_a_no_op(g, company):
    (company / "groups/eng.yaml").write_text("id: eng\nname: Eng\nparent: null\nhead: null\n")
    _git(company, "add", "groups/eng.yaml")
    head = g.head()
    assert g.commit([], "nothing") == head
    assert _git(company, "status", "--porcelain") == "M  groups/eng.yaml"


def test_broken_symlink_is_committed_not_deleted(g, company):
    (company / "link").symlink_to("nowhere")
    g.commit(["link"], "add link")
    assert g.blob_id("link") is not None
    (company / "link").unlink()
    (company / "link").symlink_to("elsewhere")
    g.commit(["link"], "move link")
    assert _git(company, "cat-file", "-p", "HEAD:link") == "elsewhere"


def test_non_utf8_paths_round_trip(g, company):
    odd = "people/b\udcffd/profile.md"  # b"\xff" as os.fsdecode spells it; APFS can't hold it
    blob = _git(company, "hash-object", "-w", PROFILE)
    _git(company, "update-index", "--add", "--cacheinfo", f"100644,{blob},{odd}")
    _git(company, "commit", "-q", "-m", "odd path")
    assert g.commit_hand_edits() == [odd]  # absent from disk, so a deletion
    assert g.blob_id(odd) is None
    assert _git(company, "status", "--porcelain") == ""


def test_handle_falls_back_to_id_on_non_utf8_person(g, company):
    (company / "people/minh/person.yaml").write_bytes(b"handle: m\xffinh\n")
    (company / PROFILE).write_text("# edited\n")
    assert g.commit_hand_edits() == [PROFILE]
    assert _git(company, "log", "-1", "--format=%s") == "profile(@minh): hand edit"


def test_unrelated_staged_file_stays_staged(g, company):
    (company / "groups/eng.yaml").write_text("id: eng\nname: Eng\nparent: null\nhead: null\n")
    _git(company, "add", "groups/eng.yaml")
    (company / PROFILE).write_text("# edited\n")
    g.commit([PROFILE], "edit")
    (company / PROFILE).write_text("# edited again\n")
    assert g.commit_hand_edits() == [PROFILE]
    assert _git(company, "log", "-2", "--name-only", "--format=").split() == [PROFILE, PROFILE]
    assert _git(company, "status", "--porcelain") == "M  groups/eng.yaml"


def test_read_blob_returns_exact_bytes(g, company):
    (company / PROFILE).write_bytes(b"# Minh\r\nline\r\n")
    g.commit([PROFILE], "crlf")
    assert g.read_blob(g.blob_id(PROFILE)) == b"# Minh\r\nline\r\n"


@pytest.mark.parametrize("ref", ["0" * 40, "HEAD", "HEAD:company.yaml", "--help",
                                 "E69DE29BB2D1D6434B8B29AE775AD8C2E48C5391"])
def test_read_blob_refuses_what_is_not_a_blob_id_here(g, ref):
    assert g.read_blob(ref) is None


def test_read_blob_refuses_a_commit_id(g):
    assert g.read_blob(g.head()) is None


def test_find_commit_matches_a_whole_line_on_the_path(g, company):
    (company / PROFILE).write_text("# one\n")
    first = g.commit([PROFILE], "profile(@minh): one\n\nCommit-Id: c-1")
    (company / "groups/eng.yaml").write_text("id: eng\nname: Eng\nparent: null\nhead: null\n")
    g.commit(["groups/eng.yaml"], "group\n\nCommit-Id: c-2")
    assert g.find_commit(PROFILE, "Commit-Id: c-1") == first
    assert g.find_commit(PROFILE, "Commit-Id: c-") is None  # a prefix is not a match
    assert g.find_commit(PROFILE, "Commit-Id: c-2") is None  # another path's commit
    assert g.find_commit("groups/eng.yaml", "Commit-Id: c-2") == g.head()


def test_unstage_keeps_the_working_file(g, company):
    (company / PROFILE).write_text("# staged\n")
    _git(company, "add", PROFILE)
    g.unstage([PROFILE])
    assert _git(company, "status", "--porcelain") == "M people/minh/profile.md"
    assert (company / PROFILE).read_text() == "# staged\n"


def test_a_hand_made_directory_name_cannot_forge_a_trailer(g, company):
    rel = "people/m\n\nCommit-Id: c-1/profile.md"
    (company / rel).parent.mkdir()
    (company / rel).write_text("# M\n")
    assert g.commit_hand_edits() == [rel]
    assert _git(company, "log", "-1", "--format=%B").strip() == "profile(@m Commit-Id: c-1): hand edit"

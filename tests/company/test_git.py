import os
import stat
import threading
import time

import pytest

from agent_corp.company.git import CompanyGit
from tests.company.conftest import _git

PROFILE = "people/minh/profile.md"


@pytest.fixture
def g(company, tmp_path):
    return CompanyGit(company, tmp_path / "worktrees")


def test_blob_id_ignores_other_files(g, company):
    before = g.blob_id(PROFILE)
    (company / "groups/eng.yaml").write_text("id: eng\nname: Eng\nparent: null\nhead: null\n")
    g.commit(["groups/eng.yaml"], "edit group")
    assert g.blob_id(PROFILE) == before
    assert g.blob_id("people/nobody/profile.md") is None


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
    (pinned / ".agent-corp-pin").unlink()
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

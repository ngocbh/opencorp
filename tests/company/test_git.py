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

"""The company at one commit, from git objects."""

import asyncio
import time

import pytest

from opencorp.company.git import CompanyGit
from opencorp.company.snapshot import CompanySnapshots, load_company_at
from tests.company.conftest import _git, person


def git_of(root):
    return CompanyGit(root, root.parent / "worktrees")


def test_people_groups_and_the_company_come_from_one_commit(company):
    git = git_of(company)
    sha = git.head()
    (company / "people" / "minh" / "person.yaml").write_text(
        "handle: minh\nname: Changed\nkind: agent\ntitle: X\nmanager: null\n")
    view = load_company_at(git, sha)  # the uncommitted edit doesn't count
    assert view.sha == sha and view.company.ceo == "ngocbh"
    assert [p.handle for p in view.people] == ["minh", "ngocbh"] and view.people[0].name == "Minh"
    assert [g.id for g in view.groups] == ["eng"] and view.issues == []


def test_people_come_without_devices_or_password_hashes(make_company):
    owner = person("ngocbh", devices=[{"name": "macbook", "token_sha256": "a" * 64}],
                   password_hash="$scrypt$ln=15,r=8,p=1$salt$hash")
    root = make_company(**{"people/ngocbh/person.yaml": owner})
    view = load_company_at(git_of(root), git_of(root).head())
    assert [p.handle for p in view.people] == ["minh", "ngocbh"] and view.issues == []
    assert all(p.devices == [] and p.password_hash is None for p in view.people)


def test_files_that_dont_parse_become_issues_without_quoting_them(make_company):
    root = make_company(**{"people/ann/person.yaml": "handle: ann\nkind: robot\nname: Ann\ntitle: T\nmanager: null\n",
                           "people/bob/person.yaml": "handle: [unclosed\n",
                           "people/cat/person.yaml": "handle: dan\nname: C\nkind: human\ntitle: T\nmanager: null\n",
                           "groups/ops.yaml": "id: other\nname: Ops\n"})
    view = load_company_at(git_of(root), git_of(root).head())
    assert {(i.path, i.code) for i in view.issues} == {
        ("people/ann/person.yaml", "repo.schema"), ("people/bob/person.yaml", "repo.unreadable"),
        ("people/cat/person.yaml", "person.dir_mismatch"), ("groups/ops.yaml", "repo.file_mismatch")}
    assert "robot" not in " ".join(i.message for i in view.issues)  # never the file's own text
    assert "ann" not in {p.handle for p in view.people}


def test_a_missing_company_file_is_null_and_an_issue(make_company):
    root = make_company(**{"company.yaml": None})
    view = load_company_at(git_of(root), git_of(root).head())
    assert view.company is None and [i.code for i in view.issues] == ["repo.unreadable"]


async def test_concurrent_callers_for_a_new_sha_share_one_load(company, monkeypatch):
    calls = []

    def slow(git, sha):
        calls.append(sha)
        time.sleep(0.1)
        return load_company_at(git, sha)

    monkeypatch.setattr("opencorp.company.snapshot.load_company_at", slow)
    snaps = CompanySnapshots(git_of(company))
    views = await asyncio.gather(*(snaps.head() for _ in range(10)))
    assert len(calls) == 1 and all(v is views[0] for v in views)
    assert await snaps.head() is views[0] and len(calls) == 1  # cached


async def test_a_new_head_is_loaded_once_it_moves(company):
    snaps = CompanySnapshots(git_of(company))
    first = await snaps.head()
    _git(company, "commit", "-q", "--allow-empty", "-m", "move")
    second = await snaps.head()
    assert second.sha != first.sha and second.sha == git_of(company).head()


async def test_a_failed_load_is_not_cached(company, monkeypatch):
    def broken(git, sha):
        raise RuntimeError("git went away")

    monkeypatch.setattr("opencorp.company.snapshot.load_company_at", broken)
    snaps = CompanySnapshots(git_of(company))
    with pytest.raises(RuntimeError):
        await snaps.head()
    monkeypatch.undo()
    assert (await snaps.head()).company.ceo == "ngocbh"


async def test_head_is_none_before_the_first_commit(tmp_path):
    root = tmp_path / "company"
    root.mkdir()
    _git(root, "init", "-q", "-b", "main")
    assert await CompanySnapshots(git_of(root)).head() is None

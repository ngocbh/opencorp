"""The company at one commit, from git objects."""

from opencorp.company.git import CompanyGit
from opencorp.company.snapshot import load_company_at
from tests.company.conftest import person


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

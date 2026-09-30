import subprocess
from importlib.resources import files

import pytest

from agent_corp.company.flows import load_confined
from agent_corp.company.lint import lint
from agent_corp.company.loader import load_repo
from agent_corp.company_template import Owner, template_files, write_company
from agent_corp.profile.debrief import DEBRIEF_FLOW
from agent_corp.profile.manager import MANAGER_FLOW
from tests.company.conftest import _isolate_git  # noqa: F401

OWNER = Owner(id="ngocbh", handle="ngocbh", name="Hong Ngoc Bui")
PACKAGED_FLOWS = {f"shared/flows/{p.name}" for p in files("agent_corp.company_template").joinpath("shared", "flows").iterdir()
                  if p.name.endswith(".yaml")}


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True, text=True).stdout


def commit_all(root, message):
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", message)


def test_a_new_company_has_the_owner_as_ceo_and_lints_clean(tmp_path):
    root = tmp_path / "company"
    written = write_company(root, tmp_path / "worktrees", company="Acme", owner=OWNER)
    assert {"company.yaml", "people/ngocbh/person.yaml", "shared/flows/chat.yaml"} <= set(written)
    repo = load_repo(root)
    assert repo.company.name == "Acme" and repo.company.ceo == "ngocbh"
    assert (repo.people["ngocbh"].kind, repo.people["ngocbh"].title, repo.people["ngocbh"].manager) == ("human", "CEO", None)
    assert repo.errors == [] and lint(repo) == []
    assert git(root, "status", "--porcelain") == ""
    assert git(root, "log", "--format=%s").splitlines() == ["onboard: create the company"]


def test_a_new_company_gets_every_packaged_flow_so_it_can_chat_debrief_and_learn(tmp_path):
    root = tmp_path / "company"
    written = write_company(root, tmp_path / "worktrees", company="Acme", owner=OWNER)
    assert {"shared/flows/chat.yaml", DEBRIEF_FLOW, MANAGER_FLOW} <= PACKAGED_FLOWS
    assert PACKAGED_FLOWS <= set(written)
    for rel in PACKAGED_FLOWS:
        assert load_confined(root, root / rel).name


def test_names_that_need_quoting_survive(tmp_path):
    owner = Owner(id="an", handle="an", name='An: "the boss" #1')
    write_company(tmp_path / "company", tmp_path / "worktrees", company="Acme: Inc. #2", owner=owner)
    repo = load_repo(tmp_path / "company")
    assert (repo.company.name, repo.people["an"].name) == ("Acme: Inc. #2", 'An: "the boss" #1')


def test_a_bad_handle_is_refused_before_anything_is_written(tmp_path):
    with pytest.raises(ValueError, match="handle"):
        write_company(tmp_path / "company", tmp_path / "worktrees", company="Acme",
                      owner=Owner(id="ngocbh", handle="Not A Handle", name="N"))
    assert not (tmp_path / "company").exists()


def test_writing_again_adds_only_missing_template_files(tmp_path):
    root = tmp_path / "company"
    write_company(root, tmp_path / "worktrees", company="Acme", owner=OWNER)
    (root / "company.yaml").write_text((root / "company.yaml").read_text().replace("Acme", "Acme Two"))
    commit_all(root, "rename")
    assert write_company(root, tmp_path / "worktrees") == []  # no owner needed once company.yaml exists
    assert git(root, "log", "--format=%s").splitlines() == ["rename", "onboard: create the company"]

    (root / "shared/flows/chat.yaml").unlink()
    commit_all(root, "drop chat")
    assert write_company(root, tmp_path / "worktrees") == ["shared/flows/chat.yaml"]
    assert git(root, "log", "-1", "--format=%s").strip() == "onboard: add template files"
    assert load_repo(root).company.name == "Acme Two"


def test_a_company_from_before_the_learning_flows_gets_them_and_keeps_its_edits(tmp_path):
    root = tmp_path / "company"
    write_company(root, tmp_path / "worktrees", company="Acme", owner=OWNER)
    (root / DEBRIEF_FLOW).unlink()
    (root / MANAGER_FLOW).unlink()
    chat = root / "shared/flows/chat.yaml"
    chat.write_text(chat.read_text() + "# the owner's edit\n")
    commit_all(root, "an old company")
    assert write_company(root, tmp_path / "worktrees") == sorted([DEBRIEF_FLOW, MANAGER_FLOW])
    assert chat.read_text().endswith("# the owner's edit\n")
    assert git(root, "status", "--porcelain") == ""
    assert lint(load_repo(root)) == []


def test_uncommitted_edits_are_neither_overwritten_nor_committed(tmp_path):
    root = tmp_path / "company"
    write_company(root, tmp_path / "worktrees", company="Acme", owner=OWNER)
    (root / DEBRIEF_FLOW).unlink()
    commit_all(root, "drop debrief")
    (root / "company.yaml").write_text((root / "company.yaml").read_text() + "# not committed\n")
    assert write_company(root, tmp_path / "worktrees") == [DEBRIEF_FLOW]
    assert git(root, "status", "--porcelain") == " M company.yaml\n"


def test_a_new_company_needs_an_owner(tmp_path):
    with pytest.raises(ValueError, match="owner"):
        write_company(tmp_path / "company", tmp_path / "worktrees")


def test_template_files_never_include_python(tmp_path):
    files_ = template_files("Acme", OWNER)
    assert "company.yaml" in files_ and "people/ngocbh/person.yaml" in files_
    assert not [p for p in files_ if p.endswith((".py", ".pyc")) or "__pycache__" in p]
    assert not [p for p in files_ if "{owner}" in p]


def test_the_first_hire_into_a_new_company_lints_clean(tmp_path):
    from agent_corp.chat.hire import Hiring
    from agent_corp.company.git import CompanyGit
    from agent_corp.protocol.models import HireRequest

    root = tmp_path / "company"
    write_company(root, tmp_path / "worktrees", company="Acme", owner=OWNER)
    hiring = Hiring(CompanyGit(root, tmp_path / "worktrees"))
    form = {"name": "Minh", "handle": "minh", "title": "Engineer", "manager": "ngocbh"}
    preview = hiring.hire(HireRequest(**form))
    assert preview.issues == []
    hiring.hire(HireRequest(**form, id=preview.person.id, confirm=True))
    assert lint(load_repo(root)) == []


def test_missing_files_names_what_writing_again_would_add(tmp_path):
    from agent_corp.company_template import missing_files

    root = tmp_path / "company"
    write_company(root, tmp_path / "worktrees", company="Acme", owner=OWNER)
    assert missing_files(root) == []
    (root / DEBRIEF_FLOW).unlink()
    commit_all(root, "drop debrief")
    assert missing_files(root) == [DEBRIEF_FLOW] == write_company(root, tmp_path / "worktrees")


def test_a_first_write_that_stopped_before_the_owners_file_is_finished(tmp_path):
    root = tmp_path / "company"
    root.mkdir()
    git(root, "init", "-q", "-b", "main")
    (root / "company.yaml").write_bytes(template_files("Acme", OWNER)["company.yaml"])
    written = write_company(root, tmp_path / "worktrees", company="Acme", owner=OWNER)
    assert "people/ngocbh/person.yaml" in written and "company.yaml" not in written
    assert lint(load_repo(root)) == []
    assert git(root, "status", "--porcelain") == ""
    assert git(root, "log", "--format=%s").splitlines() == ["onboard: create the company"]


def test_a_first_write_that_stopped_before_its_commit_is_committed(tmp_path):
    root = tmp_path / "company"
    root.mkdir()
    git(root, "init", "-q", "-b", "main")
    for rel, data in template_files("Acme", OWNER).items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_bytes(data)
    with pytest.raises(ValueError, match="owner"):
        write_company(root, tmp_path / "worktrees")  # still a new company: nothing is committed yet
    assert write_company(root, tmp_path / "worktrees", company="Acme", owner=OWNER) == []
    assert git(root, "status", "--porcelain") == ""
    assert git(root, "log", "--format=%s").splitlines() == ["onboard: create the company"]
    assert set(git(root, "ls-files").splitlines()) == set(template_files("Acme", OWNER))


def test_is_new_until_the_first_commit(tmp_path):
    from agent_corp.company_template import is_new

    root = tmp_path / "company"
    assert is_new(root)
    root.mkdir()
    git(root, "init", "-q", "-b", "main")
    (root / "company.yaml").write_text("name: Acme\n")
    assert is_new(root)
    write_company(root, tmp_path / "worktrees", company="Acme", owner=OWNER)
    assert not is_new(root)


@pytest.mark.parametrize("flow", sorted(PACKAGED_FLOWS))
def test_every_packaged_flow_is_found_missing_and_topped_up(tmp_path, flow):
    from agent_corp.company_template import missing_files

    root = tmp_path / "company"
    write_company(root, tmp_path / "worktrees", company="Acme", owner=OWNER)
    (root / flow).unlink()
    commit_all(root, f"drop {flow}")
    assert missing_files(root) == [flow] == write_company(root, tmp_path / "worktrees")

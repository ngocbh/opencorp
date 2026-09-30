import subprocess
from importlib.resources import files

import pytest
from agent_composer.memory.storage.markdown import MarkdownVersionMismatch

from agent_corp.company.flows import load_confined
from agent_corp.company.git import CompanyGit
from agent_corp.profile import GitProfileStore
from agent_corp.profile.manager import MANAGER_FLOW, ProposalNotOpen, apply_proposal, profile_tools
from agent_corp.store import Store
from tests.company.conftest import _isolate_git, base_files, write_repo  # noqa: F401
from tests.store.conftest import session


@pytest.fixture
def office(tmp_path):
    write_repo(tmp_path / "company", base_files())
    git = CompanyGit(tmp_path / "company", tmp_path / "worktrees")
    with Store(tmp_path / "store.sqlite") as store:
        yield git, store


def subject(git):
    out = subprocess.run(["git", "-C", str(git.root), "log", "-1", "--format=%s"], capture_output=True, text=True)
    return out.stdout.strip()


def test_the_profile_manager_template_loads():
    root = files("agent_corp.company_template")
    flow = load_confined(root, root / MANAGER_FLOW)
    assert flow.name == "profile_manager"


def test_propose_edit_stores_a_proposal_with_its_diff_and_replaces_older_ones(office):
    git, store = office
    s = store.create_session(session(kind="profile_manager"))
    tools = profile_tools(store, GitProfileStore(git, "minh"), s)
    read = tools["read"]()
    assert read["text"] == "# Minh, Engineer\n"
    first = tools["propose_edit"](text="# Minh\n", base_version=read["version"])
    second = tools["propose_edit"](text="# Minh, Engineer\n\n- Be brief.\n", base_version=read["version"])
    proposals = store.list_profile_proposals("minh")
    assert {p.status for p in proposals} == {"open", "discarded"}
    latest = store.list_profile_proposals("minh", status="open")[0]
    assert latest.id in second and latest.id not in first
    assert (latest.session_id, latest.base_version, latest.text) == (s.id, read["version"],
                                                                     "# Minh, Engineer\n\n- Be brief.\n")
    assert latest.diff.splitlines()[:2] == ["--- a/people/minh/profile.md", "+++ b/people/minh/profile.md"]
    assert "+- Be brief." in latest.diff.splitlines()
    with pytest.raises(LookupError):
        tools["propose_edit"](text="x", base_version="0" * 40)


def test_apply_commits_the_proposal_as_the_owner_via_the_profile_manager(office):
    git, store = office
    s = store.create_session(session(kind="profile_manager"))
    tools = profile_tools(store, GitProfileStore(git, "minh"), s)
    tools["propose_edit"](text="# Minh\n", base_version=tools["read"]()["version"])
    proposal = store.list_profile_proposals("minh", status="open")[0]
    profile = apply_proposal(store, git, proposal.id, owner="ngocbh", max_chars=5)
    assert (profile.person, profile.text, profile.over_budget) == ("minh", "# Minh\n", True)
    assert profile.version == GitProfileStore(git, "minh").read()[1]
    assert subject(git) == "profile(@minh): ngocbh via profile manager"
    applied = store.get_profile_proposal(proposal.id)
    assert (applied.status, applied.commit) == ("applied", git.head())
    assert [e.type for e in store.events_after()][-2:] == ["profile_proposal.updated", "profile.updated"]
    with pytest.raises(ProposalNotOpen, match="is applied"):
        apply_proposal(store, git, proposal.id, owner="ngocbh", max_chars=5)
    with pytest.raises(LookupError):
        apply_proposal(store, git, "01J00000000000000000000000", owner="ngocbh", max_chars=5)


def test_apply_after_a_hand_edit_is_a_conflict_and_the_proposal_goes_stale(office):
    git, store = office
    s = store.create_session(session(kind="profile_manager"))
    tools = profile_tools(store, GitProfileStore(git, "minh"), s)
    tools["propose_edit"](text="# Minh\n", base_version=tools["read"]()["version"])
    proposal = store.list_profile_proposals("minh", status="open")[0]
    (git.root / "people/minh/profile.md").write_text("# Minh, Staff Engineer\n")
    with pytest.raises(MarkdownVersionMismatch) as err:
        apply_proposal(store, git, proposal.id, owner="ngocbh", max_chars=100)
    assert err.value.expected == proposal.base_version
    assert err.value.current == GitProfileStore(git, "minh").read()[1]
    assert store.get_profile_proposal(proposal.id).status == "stale"
    assert (git.root / "people/minh/profile.md").read_text() == "# Minh, Staff Engineer\n"

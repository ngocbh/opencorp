import dataclasses

import pytest

from agent_corp.company.lint import lint
from agent_corp.company.loader import load_repo
from agent_corp.company.naming import asset_tool_name
from tests.company.conftest import base_files, person


def issues(root, severity="error"):
    return {(i.code, i.path) for i in lint(load_repo(root)) if i.severity == severity}


def codes(root, severity="error"):
    return {code for code, _ in issues(root, severity)}


def test_clean_repo_has_no_issues(company):
    assert lint(load_repo(company)) == []


def test_unknown_manager(make_company):
    root = make_company(**{"people/minh/person.yaml": person("minh", manager="ghost")})
    assert ("person.unknown_manager", "people/minh/person.yaml") in issues(root)


def test_manager_cycle_is_reported_once(make_company):
    root = make_company(**{"people/ngocbh/person.yaml": person("ngocbh", manager="minh")})
    found = [i for i in lint(load_repo(root)) if i.code == "person.manager_cycle"]
    assert len(found) == 1 and found[0].message == "minh -> ngocbh"


def test_ceo_has_manager(make_company):
    company = dict(base_files()["company.yaml"], ceo="minh")
    assert "company.ceo_has_manager" in codes(make_company(**{"company.yaml": company}))


def test_unknown_ceo(make_company):
    company = dict(base_files()["company.yaml"], ceo="ghost")
    assert "company.unknown_ceo" in codes(make_company(**{"company.yaml": company}))


def test_missing_company_yaml_does_not_crash_lint(make_company):
    assert "repo.unreadable" in codes(make_company(**{"company.yaml": None}))


def test_ids_that_differ_only_by_case(company):
    # A ULID and its lowercase spelling are both valid ids. Built in memory: their
    # files can't both exist on a case-insensitive disk.
    upper = "01J8Z3NDEKTSV4RRFFQ69G5FAV"
    lower = upper.lower()
    repo = load_repo(company)
    twins = {gid: repo.groups["eng"].model_copy(update={"id": gid}) for gid in (upper, lower)}
    repo = dataclasses.replace(repo, groups={**repo.groups, **twins})
    found = [i for i in lint(repo) if i.code == "repo.id_case_clash"]
    assert [(i.path, i.message) for i in found] == [(f"groups/{lower}.yaml",
                                                     f"{upper} and {lower} differ only by case")]


def test_unknown_group_parent_and_head(make_company):
    group = {"id": "eng", "name": "Engineering", "parent": "nope", "head": "ghost"}
    assert {"group.unknown_parent", "group.unknown_head"} <= codes(make_company(**{"groups/eng.yaml": group}))


def test_group_parent_cycle(make_company):
    root = make_company(**{
        "groups/eng.yaml": {"id": "eng", "name": "Engineering", "parent": "infra", "head": None},
        "groups/infra.yaml": {"id": "infra", "name": "Infra", "parent": "eng", "head": "minh"},
    })
    found = [i for i in lint(load_repo(root)) if i.code == "group.parent_cycle"]
    assert [i.message for i in found] == ["eng -> infra"]


def test_person_in_unknown_group(make_company):
    root = make_company(**{"people/minh/person.yaml": person("minh", groups=["eng", "nope"])})
    assert ("person.unknown_group", "people/minh/person.yaml") in issues(root)


def asset(**changes):
    return dict(base_files()["assets/fake.yaml"], **changes)


def test_asset_tool_name_matches_design():
    assert asset_tool_name("cluster-a", "submit_job") == "cluster_a__submit_job"


def test_unknown_grantees(make_company):
    grants = [{"who": "group:nope", "can": ["echo"]}, {"who": "ghost", "can": ["echo"]}]
    found = [i for i in lint(load_repo(make_company(**{"assets/fake.yaml": asset(grants=grants)})))
             if i.code == "asset.unknown_grantee"]
    assert sorted(i.message for i in found) == ["ghost", "group:nope"]


def test_person_grantee_is_known(make_company):
    grants = [{"who": "minh", "can": ["admin"]}]
    assert codes(make_company(**{"assets/fake.yaml": asset(grants=grants)})) == set()


def test_unknown_tool_in_grant(make_company):
    grants = [{"who": "group:eng", "can": ["echo", "nope"]}]
    assert "asset.unknown_tool" in codes(make_company(**{"assets/fake.yaml": asset(grants=grants)}))


def test_tool_name_too_long(make_company):
    long = "t" * 70
    files = {"assets/fake.yaml": asset(tools={long: {}}, grants=[{"who": "group:eng", "can": [long]}])}
    assert "asset.tool_name_invalid" in codes(make_company(**files))


def test_gated_tool_granted_directly_is_a_warning(make_company):
    files = {"assets/fake.yaml": asset(tools={"echo": {"risk": "gated"}})}
    root = make_company(**files)
    assert codes(root) == set()
    assert "asset.gated_tool_granted" in codes(root, "warning")


def test_missing_flow(make_company):
    root = make_company(**{"people/minh/person.yaml": person("minh", main="../../shared/flows/nope.yaml")})
    assert "person.flow_missing" in codes(root)


def test_invalid_flow_carries_composer_message(make_company):
    root = make_company(**{"shared/flows/chat.yaml": "id: chat\nname: chat\noutputs: 1\n"})
    [issue] = [i for i in lint(load_repo(root)) if i.code == "person.flow_invalid"]
    assert "output" in issue.message and "LoadError" not in issue.message


def test_unexpected_flow_error_names_its_type(company, monkeypatch):
    def boom(root, path):
        raise KeyError("x")
    monkeypatch.setattr("agent_corp.company.lint.load_confined", boom)
    [issue] = [i for i in lint(load_repo(company)) if i.code == "person.flow_invalid"]
    assert issue.message == "../../shared/flows/chat.yaml: KeyError: 'x'"


def test_flow_outside_repo(make_company):
    root = make_company(**{"people/minh/person.yaml": person("minh", main="../../../etc/passwd")})
    [issue] = [i for i in lint(load_repo(root)) if i.code == "person.flow_outside_repo"]
    assert str(root.parent.resolve()) not in issue.message and "../etc/passwd" in issue.message


def test_flow_cycle_message_is_repo_relative(make_company):
    root = make_company(**{"shared/flows/chat.yaml": parent_flow("chat")})
    [issue] = [i for i in lint(load_repo(root)) if i.code == "person.flow_invalid"]
    assert str(root.resolve()) not in issue.message and "shared/flows/chat.yaml" in issue.message


CHILD = "id: echo\nname: echo\ninput:\n  text: !str\noutput: str\nkind: agent\nprompt: \"${text}\"\n"


def parent_flow(ref):
    return ("id: chat\nname: chat\nuses:\n  echo: " + ref + "\nnodes:\n  ask:\n    kind: human_input\n"
            "    prompt: \"you> \"\n    output: str\n  reply:\n    kind: call\n    call: echo\n"
            "    input:\n      text: ${ask.output}\noutput: ${reply.output}\n")


def test_child_flow_inside_repo_is_fine(make_company):
    root = make_company(**{"shared/flows/chat.yaml": parent_flow("echo"), "shared/flows/echo.yaml": CHILD})
    assert codes(root) == set()


def test_child_flow_outside_repo(make_company, tmp_path):
    (tmp_path / "echo.yaml").write_text(CHILD)  # tmp_path/company is the repo
    root = make_company(**{"shared/flows/chat.yaml": parent_flow("../../../echo")})
    [issue] = [i for i in lint(load_repo(root)) if i.code == "person.flow_outside_repo"]
    assert str(tmp_path.resolve()) not in issue.message and "../echo.yaml" in issue.message


def test_repo_reached_through_a_symlink(company, tmp_path):
    (tmp_path / "link").symlink_to(company)
    assert lint(load_repo(tmp_path / "link")) == []


def test_sop_flows_are_checked(make_company):
    sops = [{"flow": "../../shared/flows/nope.yaml"}]
    assert "person.flow_missing" in codes(make_company(**{"people/minh/person.yaml": person("minh", sops=sops)}))


def test_routine_flows_are_checked(make_company):
    routines = [{"name": "daily", "flow": "../../shared/flows/nope.yaml"}]
    root = make_company(**{"people/minh/person.yaml": person("minh", routines=routines)})
    assert "person.flow_missing" in codes(root)


@pytest.mark.parametrize("field", ["main", "sops", "routines"])
def test_nul_byte_in_a_flow_ref_is_invalid(make_company, field):
    ref = "../../shared/flows/chat\0.yaml"
    value = {"main": ref, "sops": [{"flow": ref}], "routines": [{"name": "daily", "flow": ref}]}[field]
    root = make_company(**{"people/minh/person.yaml": person("minh", **{field: value})})
    [issue] = [i for i in lint(load_repo(root)) if i.code == "person.flow_invalid"]
    assert issue.path == "people/minh/person.yaml" and "\0" not in issue.message


def test_agent_needs_a_main_flow(make_company):
    minh = person("minh")
    del minh["main"]
    assert ("person.no_main", "people/minh/person.yaml") in issues(make_company(**{"people/minh/person.yaml": minh}))


def test_system_paths_is_refused(make_company):
    flow = parent_flow("echo").replace("uses:", "system:\n  paths: [lib]\nuses:", 1)
    root = make_company(**{"shared/flows/chat.yaml": flow, "shared/flows/lib/echo.yaml": CHILD})
    [issue] = [i for i in lint(load_repo(root)) if i.code == "person.flow_invalid"]
    assert "system.paths" in issue.message


def test_unknown_skill(make_company):
    root = make_company(**{"people/minh/person.yaml": person("minh", skills=["nope"])})
    assert ("person.unknown_skill", "people/minh/person.yaml") in issues(root)


def test_personal_skill_is_found(make_company):
    root = make_company(**{
        "people/minh/person.yaml": person("minh", skills=["mine"]),
        "people/minh/skills/mine/SKILL.md": "---\nname: mine\ndescription: Mine.\n---\nMine.\n",
    })
    assert codes(root) == set()


def test_invalid_skill_is_reported(make_company):
    root = make_company(**{"shared/skills/broken/SKILL.md": "no frontmatter\n"})
    assert ("skill.invalid", "shared/skills/broken") in issues(root)


def test_duplicate_skill_name_in_one_root(make_company):
    root = make_company(**{"shared/skills/review2/SKILL.md": "---\nname: code-review\ndescription: Again.\n---\nx\n"})
    assert ("skill.invalid", "shared/skills/review2") in issues(root)


def test_agent_without_profile_is_a_warning(make_company):
    root = make_company(**{"people/minh/profile.md": None})
    assert codes(root) == set()
    assert ("person.no_profile", "people/minh/profile.md") in issues(root, "warning")


def test_human_without_profile_is_fine(company):
    assert "person.no_profile" not in codes(company, "warning")


def _device(name: str, digit: str = "a") -> dict:
    return {"name": name, "token_sha256": digit * 64}


def test_an_agent_with_devices(make_company):
    root = make_company(**{"people/minh/person.yaml": person("minh", devices=[_device("box")])})
    assert ("person.agent_devices", "people/minh/person.yaml") in issues(root)


def test_two_devices_with_one_name(make_company):
    root = make_company(**{"people/ngocbh/person.yaml": person("ngocbh", devices=[_device("mac"),
                                                                                 _device("mac", "b")])})
    found = [i for i in lint(load_repo(root)) if i.code == "person.duplicate_device"]
    assert [(i.path, i.message) for i in found] == [("people/ngocbh/person.yaml", "mac")]


def test_a_token_hash_two_people_list(make_company):
    ava = dict(person("ngocbh", handle="ava", name="Ava", manager="ngocbh"), devices=[_device("pc")])
    root = make_company(**{"people/ngocbh/person.yaml": person("ngocbh", devices=[_device("mac")]),
                           "people/ava/person.yaml": ava})
    found = sorted((i.path, i.message) for i in lint(load_repo(root)) if i.code == "person.shared_device_token")
    assert found == [("people/ava/person.yaml", "device pc's token is also listed by ngocbh"),
                     ("people/ngocbh/person.yaml", "device mac's token is also listed by ava")]
    assert "token_sha256" not in str(found) and "a" * 64 not in str(found)


def test_devices_with_distinct_names_and_hashes_are_clean(make_company):
    root = make_company(**{"people/ngocbh/person.yaml": person("ngocbh", devices=[_device("mac"),
                                                                                 _device("pc", "b")])})
    assert lint(load_repo(root)) == []


def test_an_agent_with_a_password(make_company):
    phc = "$scrypt$ln=15,r=8,p=1$c2FsdA$aGFzaA"
    root = make_company(**{"people/minh/person.yaml": person("minh", password_hash=phc),
                           "people/ngocbh/person.yaml": person("ngocbh", password_hash=phc)})
    found = [(i.code, i.path) for i in lint(load_repo(root)) if i.code == "person.agent_password"]
    assert found == [("person.agent_password", "people/minh/person.yaml")]

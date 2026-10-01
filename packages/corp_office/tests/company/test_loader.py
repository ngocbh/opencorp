from agent_composer import load_flow

from agent_corp.company.loader import load_repo
from tests.company.conftest import person


def codes(repo):
    return {(i.path, i.code) for i in repo.errors}


def test_loads_people_groups_assets(company):
    repo = load_repo(company)
    assert repo.errors == []
    assert repo.company.ceo == "ngocbh"
    assert set(repo.people) == {"ngocbh", "minh"}
    assert repo.people["minh"].handle == "minh"
    assert repo.people["minh"].kind == "agent"
    assert repo.groups["eng"].name == "Engineering"
    assert repo.assets["fake"].tools.keys() == {"echo"}


def test_ids_are_plain_strings(company):
    repo = load_repo(company)
    assert type(repo.people["minh"].handle) is str
    assert type(repo.people["minh"].manager) is str
    assert type(repo.people["minh"].kind) is str


def test_chat_flow_fixture_loads(company):
    path = company / "shared/flows/chat.yaml"
    load_flow(path.read_text(), search_paths=[path.parent], source_label=str(path))


def test_unknown_field_is_a_schema_error(make_company):
    root = make_company(**{"people/minh/person.yaml": person("minh", colour="blue")})
    assert ("people/minh/person.yaml", "repo.schema") in codes(load_repo(root))
    assert "minh" not in load_repo(root).people


def test_handle_must_match_directory(make_company):
    root = make_company(**{"people/minh/person.yaml": person("minh", handle="other")})
    repo = load_repo(root)
    assert ("people/minh/person.yaml", "person.dir_mismatch") in codes(repo)
    assert "minh" not in repo.people and "other" not in repo.people


def test_people_are_keyed_by_handle(company):
    assert sorted(load_repo(company).people) == ["minh", "ngocbh"]


def test_group_id_must_match_file_name(make_company):
    root = make_company(**{"groups/eng.yaml": {"id": "ops", "name": "Ops"}})
    assert ("groups/eng.yaml", "repo.file_mismatch") in codes(load_repo(root))


def test_malformed_yaml_is_unreadable(make_company):
    root = make_company(**{"groups/eng.yaml": "id: [eng\n"})
    assert ("groups/eng.yaml", "repo.unreadable") in codes(load_repo(root))


def test_non_utf8_file_is_unreadable(make_company):
    root = make_company(**{"groups/eng.yaml": b"id: \xff\xfe\n"})
    assert ("groups/eng.yaml", "repo.unreadable") in codes(load_repo(root))


def test_missing_company_yaml(make_company):
    repo = load_repo(make_company(**{"company.yaml": None}))
    assert repo.company is None
    assert ("company.yaml", "repo.unreadable") in codes(repo)

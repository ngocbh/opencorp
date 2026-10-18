from dataclasses import replace

from opencorp.chat.identity import person_inputs, talking_to
from opencorp.company.loader import load_repo
from tests.company.conftest import _isolate_git, company  # noqa: F401


def test_an_agent_with_a_manager_is_named_with_its_company_and_who_it_reports_to(company):  # noqa: F811
    repo = load_repo(company)
    assert person_inputs(repo, repo.people["minh"]) == {
        "name": "Minh", "handle": "minh", "title": "Engineer", "company": "test-corp",
        "reports_to": "You report to Hong Ngoc Bui (@ngocbh)."}


def test_a_person_without_a_manager_reports_to_no_one(company):  # noqa: F811
    repo = load_repo(company)
    assert person_inputs(repo, repo.people["ngocbh"])["reports_to"] == ""


def test_a_manager_missing_from_the_repo_is_left_out(company):  # noqa: F811
    repo = load_repo(company)
    minh = repo.people["minh"].model_copy(update={"manager": "ghost"})
    assert person_inputs(repo, minh)["reports_to"] == ""


def test_a_repo_without_a_company_gives_an_empty_company(company):  # noqa: F811
    repo = replace(load_repo(company), company=None)
    assert person_inputs(repo, repo.people["minh"])["company"] == ""


def human(repo, handle, name, manager):
    """A human in ``repo`` with ``manager``, as ``people/<handle>/person.yaml`` would load."""
    return repo.people["ngocbh"].model_copy(update={"handle": handle, "name": name, "title": "Designer",
                                                    "manager": manager})


def with_people(repo, *people):
    return replace(repo, people=repo.people | {p.handle: p for p in people})


def test_the_ceo_who_is_also_the_manager_is_both(company):  # noqa: F811
    repo = load_repo(company)
    expected = "You're talking with Hong Ngoc Bui (@ngocbh), the CEO and your manager."
    assert talking_to(repo, repo.people["minh"], "ngocbh") == expected
    assert talking_to(repo, repo.people["minh"], None) == expected  # a session that doesn't say falls back to the CEO


def test_a_manager_a_direct_report_a_peer_and_someone_else(company):  # noqa: F811
    repo = load_repo(company)
    repo = with_people(repo, human(repo, "lan", "Lan", "ngocbh"), human(repo, "kai", "Kai", "minh"),
                       human(repo, "ava", "Ava", "lan"))
    minh = repo.people["minh"]
    assert talking_to(repo, minh, "lan") == "You're talking with Lan (@lan), your peer."
    assert talking_to(repo, minh, "kai") == "You're talking with Kai (@kai), your direct report."
    assert talking_to(repo, minh, "ava") == "You're talking with Ava (@ava)."
    reports_to_lan = minh.model_copy(update={"manager": "lan"})
    assert talking_to(repo, reports_to_lan, "lan") == "You're talking with Lan (@lan), your manager."
    assert talking_to(repo, reports_to_lan, "ngocbh") == "You're talking with Hong Ngoc Bui (@ngocbh), the CEO."


def test_no_one_known_or_the_person_themselves_gives_no_line(company):  # noqa: F811
    repo = load_repo(company)
    minh = repo.people["minh"]
    assert talking_to(repo, minh, "ghost") == ""
    assert talking_to(repo, minh, "minh") == ""
    assert talking_to(replace(repo, company=None), minh, None) == ""


def test_two_people_without_a_manager_are_not_peers(company):  # noqa: F811
    repo = load_repo(company)
    repo = with_people(repo, human(repo, "solo", "Solo", None))
    minh = repo.people["minh"].model_copy(update={"manager": None})
    assert talking_to(repo, minh, "solo") == "You're talking with Solo (@solo)."

from dataclasses import replace

from agent_corp.chat.identity import person_inputs
from agent_corp.company.loader import load_repo
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

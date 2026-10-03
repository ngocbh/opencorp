"""The tools for drafting a new company."""

from langchain_core.tools import StructuredTool

from agent_corp.tools.company.draft import check_company

OWNER = {"name": "Hong Ngoc Bui", "handle": "ngocbh", "title": "CEO"}


def test_check_company_says_no_problems_for_a_good_company():
    assert check_company("Acme", OWNER, [{"name": "Minh", "handle": "minh", "title": "Engineer"}]) == "No problems."


def test_check_company_lists_each_problem_and_says_to_ask_the_owner():
    result = check_company("Acme", OWNER, [{"name": "Ngoc", "handle": "ngocbh", "title": "Engineer"},
                                           {"name": "Minh", "handle": "Minh", "title": "QA"}])
    lines = result.splitlines()
    assert lines[0] == "Problems; ask the owner how to fix each, then check again:"
    assert "- @ngocbh is taken" in lines
    assert any(line.startswith("- @Minh can't be a handle") for line in lines)


def test_check_company_takes_a_partial_draft_and_names_what_is_missing():
    result = check_company("Acme", {"name": "Hong Ngoc Bui", "handle": "ngocbh"}, [{"name": "Minh", "handle": "minh"}])
    assert "- the teammate @minh needs a title" in result.splitlines()
    assert check_company().startswith("Problems; ask the owner")


def test_check_companys_schema_types_every_field_the_check_reads():
    schema = StructuredTool.from_function(check_company, name="check_company").args_schema.model_json_schema()
    assert set(schema["properties"]) == {"company", "owner", "teammates"}
    assert set(schema["$defs"]["CheckOwner"]["properties"]) == {"name", "handle", "title"}
    assert set(schema["$defs"]["CheckTeammate"]["properties"]) == {"name", "handle", "title"}

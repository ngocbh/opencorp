"""A proposed company and its problems."""

import pytest

from agent_corp.company.draft import Answers, Teammate, answer_problems
from agent_corp.company_template import Owner

ME = Owner(handle="ngocbh", name="Hong Ngoc Bui", title="CEO")
GOOD = Answers("Acme", ME, (Teammate("Minh", "minh", "Engineer", "Writes the backend."), Teammate("Lan", "lan", "QA")))


def test_good_answers_have_no_problems():
    assert answer_problems(GOOD) == []
    assert answer_problems(Answers("Acme", ME, ())) == []


def test_a_bad_owner_handle_is_named_with_why():
    [problem] = answer_problems(Answers("Acme", Owner(handle="Hong Ngoc", name="Hong Ngoc Bui"), ()))
    assert problem.startswith("@Hong Ngoc ") and "pattern" in problem


def test_a_teammate_cant_take_the_owners_handle():
    assert answer_problems(Answers("Acme", ME, (Teammate("Ngoc", "ngocbh", "Engineer"),))) == ["@ngocbh is taken"]


def test_two_teammates_cant_share_a_handle():
    team = (Teammate("Minh", "minh", "Engineer"), Teammate("Minh Anh", "minh", "QA"))
    assert answer_problems(Answers("Acme", ME, team)) == ["@minh is taken"]


@pytest.mark.parametrize("answers", [
    Answers(" ", ME, ()),
    Answers("Acme", Owner(handle="ngocbh", name=""), ()),
    Answers("Acme", ME, (Teammate("", "minh", "Engineer"),)),
    Answers("Acme", ME, (Teammate("Minh", "minh", ""),)),
])
def test_a_missing_name_or_title_is_a_problem(answers):
    assert len(answer_problems(answers)) == 1


def test_answers_come_from_the_flows_output():
    output = {"company": "Acme", "owner": {"name": "Hong Ngoc Bui", "handle": "ngocbh", "title": "CEO"},
              "teammates": [{"name": "Minh", "handle": "minh", "title": "Engineer", "about": "Writes the backend."},
                            {"name": "Lan", "handle": "lan", "title": "QA", "about": ""}]}
    assert Answers.from_output(output) == GOOD

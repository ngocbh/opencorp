import pytest
from agent_composer import load_flow

from agent_corp.company_template import Owner
from agent_corp.install import interview
from agent_corp.install import onboard as onboard_module
from agent_corp.install.interview import (FLOW, Answers, Known, Teammate, answer_problems, clean, fallback_answers,
                                          summary)
from agent_corp.install.onboard import OnboardError

ME = Owner(handle="ngocbh", name="Hong Ngoc Bui", title="CEO")
GOOD = Answers("Acme", ME, (Teammate("Minh", "minh", "Engineer", "Writes the backend."), Teammate("Lan", "lan", "QA")))


@pytest.fixture
def login(monkeypatch):
    monkeypatch.setattr(interview, "login_defaults", lambda: ("Me", "me"))


def test_the_flow_loads_and_takes_what_init_knows_a_draft_and_changes():
    flow = load_flow(FLOW.read_text(), source_label=str(FLOW))
    assert {p.name: p.contract.type.kind.value for p in flow.input} == {"known": "str", "draft": "str",
                                                                         "changes": "str"}


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


def test_known_facts_are_the_given_flags_and_suggestions_but_never_the_remote(login):
    known = Known(company="Acme", agent_handle="bo", remote="https://user:secret@example.com/acme.git")
    assert known.facts() == {"given": {"company": "Acme", "agent_handle": "bo"},
                             "suggested": {"name": "Me", "handle": "me", "title": "CEO"}}


def test_without_flags_the_fallback_is_a_default_company(login):
    assert fallback_answers(Known()) == Answers("My company", Owner(handle="me", name="Me", title="CEO"),
                                                (Teammate("Minh", "minh", "Engineer"),))


def test_the_fallback_uses_every_flag(login):
    known = Known(company="Acme", name="Lan", handle="lan", title="CTO", agent="Bo", agent_handle="bo-1")
    assert fallback_answers(known) == Answers("Acme", Owner(handle="lan", name="Lan", title="CTO"),
                                              (Teammate("Bo", "bo-1", "Engineer"),))


def test_the_fallback_slugs_the_agents_name_for_a_handle(login):
    assert fallback_answers(Known(agent="Minh Anh")).team[0].handle == "minh-anh"
    assert fallback_answers(Known(agent="Đ")).team[0].handle == "agent"


def test_a_fallback_with_problems_names_the_flag_to_pass(login):
    with pytest.raises(OnboardError, match="@minh is taken; pass --agent-handle"):
        fallback_answers(Known(handle="minh"))
    with pytest.raises(OnboardError, match="@Me .*; pass --handle"):
        fallback_answers(Known(handle="Me"))


def test_answers_come_from_the_flows_output():
    output = {"company": "Acme", "owner": {"name": "Hong Ngoc Bui", "handle": "ngocbh", "title": "CEO"},
              "teammates": [{"name": "Minh", "handle": "minh", "title": "Engineer", "about": "Writes the backend."},
                            {"name": "Lan", "handle": "lan", "title": "QA", "about": ""}]}
    assert Answers.from_output(output) == GOOD


def test_the_summary_lists_the_company_you_and_each_teammate():
    assert summary(GOOD) == ["Company: Acme", "You: Hong Ngoc Bui (@ngocbh), CEO", "Teammates:",
                             "  Minh (@minh), Engineer: Writes the backend.", "  Lan (@lan), QA"]
    assert summary(Answers("Acme", ME, ()))[-1] == "Teammates: none yet"


def test_the_summary_strips_control_characters_from_model_text():
    answers = Answers("Ac\x1b[2Jme", Owner(handle="ngocbh", name="Hong\nNgoc\x07 Bui"),
                      (Teammate("Mi\rnh", "minh", "Eng\tineer", "Writes\x7f the backend."),))
    assert summary(answers) == ["Company: Ac[2Jme", "You: Hong Ngoc Bui (@ngocbh), CEO", "Teammates:",
                                "  Mi nh (@minh), Eng ineer: Writes the backend."]


def test_clean_turns_line_breaks_and_tabs_into_spaces_and_drops_other_control_characters():
    assert clean("a\nb\rc\td\x00e\x1bf\x7fg") == "a b c defg"


def test_clean_drops_c1_control_characters_which_some_terminals_read_as_escapes():
    assert clean("a\x80b\x9b2Jc\x9fd\xa0e") == "ab2Jcd\xa0e"


def test_the_fallback_needs_an_account_even_with_every_flag(monkeypatch):
    def unknown(uid):
        raise KeyError(f"getpwuid(): uid not found: {uid}")

    monkeypatch.setattr(onboard_module.pwd, "getpwuid", unknown)
    with pytest.raises(OnboardError, match="no account"):
        fallback_answers(Known(company="Acme", name="Lan", handle="lan", title="CTO", agent="Bo", agent_handle="bo"))

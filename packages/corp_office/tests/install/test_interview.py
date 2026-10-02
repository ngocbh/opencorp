import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from agent_composer import load_flow

from agent_corp.chat.provider import Provider
from agent_corp.company_template import Owner
from agent_corp.install import interview as interview_module
from agent_corp.install import onboard as onboard_module
from agent_corp.install.interview import (CONFIRM, FLOW, Answers, Known, Teammate, answer_problems, clean,
                                          fallback_answers, interview, run_interview, summary)
from agent_corp.install.onboard import TRIES, OnboardError
from agent_corp.testing.fake_llm import LLM_CONFIG, FakeLLM

from .test_provider_setup import Script

ME = Owner(handle="ngocbh", name="Hong Ngoc Bui", title="CEO")
GOOD = Answers("Acme", ME, (Teammate("Minh", "minh", "Engineer", "Writes the backend."), Teammate("Lan", "lan", "QA")))
OUT = {"company": "Acme", "owner": {"name": "Hong Ngoc Bui", "handle": "ngocbh", "title": "CEO"},
       "teammates": [{"name": "Minh", "handle": "minh", "title": "Engineer", "about": "Writes the backend."}]}
PROVIDER_PATH = Path("/office/provider.json")
KEY = "sk-SENTINEL-not-a-real-key"


@pytest.fixture
def login(monkeypatch):
    monkeypatch.setattr(interview_module, "login_defaults", lambda: ("Me", "me"))


@pytest.fixture
def fake_llm():
    with FakeLLM() as fake:
        yield fake


@pytest.fixture
def provider(fake_llm):
    return Provider(llm_config=LLM_CONFIG, env=fake_llm.env())


def interview_replies(question, output, options=None):
    args = {"question": question, **({"options": options} if options else {})}
    return ({"tool_calls": [{"name": "ask_user", "arguments": args}]},
            {"content": "That's everything."},  # ends the tool loop
            {"tool_calls": [{"name": "Record", "arguments": output}]})  # forced structured output


def run(provider, prompter, known=Known(), draft="", changes=""):
    return run_interview(provider, prompter, known, draft=draft, changes=changes, provider_path=PROVIDER_PATH)


def contents(request):
    """Each message's content in a model request, as text."""
    return [m["content"] if isinstance(m["content"], str) else str(m["content"]) for m in request["messages"]]


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


def test_the_interview_asks_on_the_terminal_and_returns_the_flows_output(login, fake_llm, provider):
    fake_llm.script(*interview_replies("What's the company called?", OUT))
    prompter = Script("Acme")
    assert run(provider, prompter) == OUT
    assert "What's the company called?" in prompter.seen
    assert "Acme" in contents(fake_llm.requests()[1])[-1]


@pytest.mark.parametrize(("answer", "result"), [("2", "Founder"), ("3", "3"), ("Chair", "Chair")])
def test_a_numbered_answer_picks_an_option_and_any_other_is_sent_as_typed(login, fake_llm, provider, answer, result):
    fake_llm.script(*interview_replies("Your title?", OUT, options=["CEO", "Founder"]))
    prompter = Script(answer)
    run(provider, prompter)
    assert prompter.seen == ["  1. CEO", "  2. Founder", "Your title?"]
    assert contents(fake_llm.requests()[1])[-1] == result


def test_questions_and_options_are_asked_without_control_characters(login, fake_llm, provider):
    fake_llm.script(*interview_replies("Clear\x1b[2J?", OUT, options=["a\x9bb", "c"]))
    prompter = Script("x")
    run(provider, prompter)
    assert prompter.seen == ["  1. ab", "  2. c", "Clear[2J?"]


def test_the_providers_env_is_set_only_during_the_run(login, fake_llm, provider, monkeypatch):
    monkeypatch.delenv("VLLM_BASE_URL", raising=False)
    fake_llm.script(*interview_replies("Company?", OUT))
    run(provider, Script("Acme"))
    assert "VLLM_BASE_URL" not in os.environ
    assert len(fake_llm.requests()) == 3


def test_the_run_sees_only_the_office_workers_env_and_the_providers(login, monkeypatch):
    monkeypatch.setenv("SHELL_ONLY_SENTINEL", "x")
    before = dict(os.environ)
    seen = {}

    def recorder(*args, **kwargs):
        seen.update(os.environ)
        return SimpleNamespace(status="succeeded", output=OUT, failure=None)

    monkeypatch.setattr(interview_module, "run_flow", recorder)
    assert run(Provider(env={"VLLM_BASE_URL": "http://fake/v1"}), Script()) == OUT
    assert seen["VLLM_BASE_URL"] == "http://fake/v1" and seen["PATH"] == before["PATH"]
    assert "SHELL_ONLY_SENTINEL" not in seen
    assert dict(os.environ) == before


@pytest.mark.parametrize(("error", "raised"), [(RuntimeError("boom"), OnboardError),
                                               (KeyboardInterrupt(), KeyboardInterrupt)])
def test_the_env_is_restored_when_the_run_raises(login, monkeypatch, error, raised):
    before = dict(os.environ)

    def raising(*args, **kwargs):
        raise error

    monkeypatch.setattr(interview_module, "run_flow", raising)
    with pytest.raises(raised):
        run(Provider(env={"VLLM_BASE_URL": "http://fake/v1"}), Script())
    assert dict(os.environ) == before


def test_a_failed_run_says_the_model_couldnt_run_the_interview(login, fake_llm, provider):
    fake_llm.script({"error": 500})
    with pytest.raises(OnboardError, match="couldn't run the interview") as caught:
        run(provider, Script())
    assert str(PROVIDER_PATH) in str(caught.value)
    assert len(fake_llm.requests()) == 1


@pytest.mark.parametrize("outcome", ["result", "exception"])
def test_a_failure_message_never_shows_the_key_or_url_credentials(login, monkeypatch, outcome):
    message = f"bad key {KEY} for https://user:hunter2@example.com/v1"

    def run_flow(*args, **kwargs):
        if outcome == "exception":
            raise RuntimeError(message)
        return SimpleNamespace(status="failed", output=None, failure=SimpleNamespace(message=message))

    monkeypatch.setattr(interview_module, "run_flow", run_flow)
    with pytest.raises(OnboardError) as caught:
        run(Provider(llm_config={**LLM_CONFIG, "api_key": KEY}), Script())
    assert "bad key *** for https://***@example.com/v1" in str(caught.value)
    assert KEY not in str(caught.value) and "hunter2" not in str(caught.value)


class Closed(Script):
    """A prompter whose input has ended."""

    error = OnboardError("no answer to 'Company?' (stdin closed)")

    def ask(self, question, default=""):
        self.seen.append(question)
        raise self.error


def test_when_the_owners_input_ends_its_error_stops_the_interview(login, fake_llm, provider):
    fake_llm.script(*interview_replies("Company?", OUT))
    with pytest.raises(OnboardError) as caught:
        run(provider, Closed())
    assert caught.value is Closed.error
    assert len(fake_llm.requests()) == 1


def test_the_model_is_told_what_is_known_the_draft_and_the_changes(login, fake_llm, provider):
    fake_llm.script(*interview_replies("Company?", OUT))
    run(provider, Script("x"), Known(company="Acme"), draft='{"company": "Draft Co"}', changes="@minh is taken")
    text = "\n".join(contents(fake_llm.requests()[0]))
    assert '"given": {"company": "Acme"}' in text
    assert "Draft Co" in text and "@minh is taken" in text


def bad_output(handle="Minh"):
    return {**OUT, "teammates": [{**OUT["teammates"][0], "handle": handle}]}


@pytest.fixture
def interviews(monkeypatch):
    """Stands in for ``run_interview``: returns the queued outputs and records each call's draft and changes."""
    fake = SimpleNamespace(outputs=[], calls=[])

    def run_interview(provider, prompter, known, *, draft, changes, provider_path):
        fake.calls.append({"draft": draft, "changes": changes})
        return fake.outputs.pop(0)

    monkeypatch.setattr(interview_module, "run_interview", run_interview)
    return fake


def test_a_clean_result_is_summarized_and_confirmed(login, interviews, tmp_path):
    interviews.outputs = [OUT]
    prompter = Script("")
    answers = interview(tmp_path / "provider.json", prompter, Known())
    assert answers == Answers.from_output(OUT)
    assert prompter.seen == [*summary(answers), CONFIRM]
    assert interviews.calls == [{"draft": "", "changes": ""}]


def test_a_result_with_problems_runs_again_with_the_draft_and_the_problems(login, interviews, tmp_path):
    interviews.outputs = [bad_output(), OUT]
    prompter = Script("")
    interview(tmp_path / "provider.json", prompter, Known())
    assert interviews.calls[1] == {"draft": json.dumps(bad_output()),
                                   "changes": "\n".join(answer_problems(Answers.from_output(bad_output())))}
    assert "@Minh can't be a handle" in interviews.calls[1]["changes"]
    assert prompter.seen.count(CONFIRM) == 1


def test_a_result_missing_a_field_is_a_problem(login, interviews, tmp_path):
    interviews.outputs = [{"company": "Acme", "teammates": []}, OUT]
    interview(tmp_path / "provider.json", Script(""), Known())
    assert interviews.calls[1]["changes"] == "the result was missing owner"


@pytest.mark.parametrize(("reply", "changes"), [("rename Minh to Bo", "The owner wants changes: rename Minh to Bo"),
                                                ("n", "The owner wants changes; ask what to change"),
                                                (" No ", "The owner wants changes; ask what to change")])
def test_the_owner_can_ask_for_changes(login, interviews, tmp_path, reply, changes):
    interviews.outputs = [OUT, OUT]
    interview(tmp_path / "provider.json", Script(reply, "y"), Known())
    assert interviews.calls[1] == {"draft": json.dumps(OUT), "changes": changes}


def test_the_interview_gives_up_after_tries_results_with_problems(login, interviews, tmp_path):
    interviews.outputs = [bad_output()] * (TRIES - 1) + [bad_output("Mi\x1bnh")]
    prompter = Script()
    with pytest.raises(OnboardError, match="didn't settle") as caught:
        interview(tmp_path / "provider.json", prompter, Known())
    assert "@Minh can't be a handle" in str(caught.value) and "\x1b" not in str(caught.value)
    assert len(interviews.calls) == TRIES
    assert CONFIRM not in prompter.seen


def test_the_owners_change_rounds_dont_count_against_tries(login, interviews, tmp_path):
    rounds = TRIES + 1
    interviews.outputs = [OUT] * (rounds + 1)
    assert interview(tmp_path / "provider.json", Script(*["change it"] * rounds, "Y"), Known()) == \
        Answers.from_output(OUT)
    assert len(interviews.calls) == rounds + 1


def test_without_a_terminal_the_fallback_is_used_without_a_model_or_confirmation(login, interviews, monkeypatch,
                                                                                tmp_path):
    def no_provider(path):
        raise AssertionError("the provider was loaded")

    monkeypatch.setattr(interview_module, "load_provider", no_provider)
    prompter = Script(interactive=False)
    assert interview(tmp_path / "provider.json", prompter, Known(company="Acme")) == \
        fallback_answers(Known(company="Acme"))
    assert interviews.calls == [] and prompter.seen == []


def test_without_a_terminal_problems_name_the_flag_to_pass(login, interviews, tmp_path):
    with pytest.raises(OnboardError, match="@minh is taken; pass --agent-handle"):
        interview(tmp_path / "provider.json", Script(interactive=False), Known(handle="minh"))

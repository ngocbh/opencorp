import json
import os
import warnings
from types import SimpleNamespace

import pytest
import yaml
from agent_composer import load_flow

from agent_corp.auth.passwords import check_password
from agent_corp.chat.provider import Provider
from agent_corp.company.draft import Draft, Teammate, draft_problems
from agent_corp.company_template import Owner
from agent_corp.install import interview as interview_module
from agent_corp.install import onboard as onboard_module
from agent_corp.install.init import REMOTE
from agent_corp.install.interview import (CHANGE, CONFIRM, CREATE, FLOW, WHAT_TO_CHANGE, Asking, Known, ModelError,
                                          ask_user, asking, clean, confirm, fallback_draft, init_flow, model_problem,
                                          run_init_flow, summary)
from agent_corp.install.onboard import TRIES, OnboardError
from agent_corp.testing.fake_llm import LLM_CONFIG, FakeLLM

from .test_provider_setup import Script

ME = Owner(handle="ngocbh", name="Hong Ngoc Bui", title="CEO")
GOOD = Draft("Acme", ME, (Teammate("Minh", "minh", "Engineer", "Writes the backend."), Teammate("Lan", "lan", "QA")))
OUT = {"company": "Acme", "owner": {"name": "Hong Ngoc Bui", "handle": "ngocbh", "title": "CEO"},
       "teammates": [{"name": "Minh", "handle": "minh", "title": "Engineer", "about": "Writes the backend."}]}
KEY = "sk-SENTINEL-not-a-real-key"
PASSWORD = "pw-sentinel-5d1f"


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


def flow_replies(question, output, options=None):
    """One interview round from the model: ask ``question``, check ``output``, then return it."""
    args = {"question": question, **({"options": options} if options else {})}
    check = {k: output[k] for k in ("company", "owner", "teammates")}
    return ({"tool_calls": [{"name": "ask_user", "arguments": args}]},
            {"tool_calls": [{"name": "check_company", "arguments": check}]},
            {"content": "That's everything."},  # ends the tool loop
            {"tool_calls": [{"name": "Record", "arguments": output}]})  # forced structured output


def round_replies(output):
    """An interview round that returns ``output`` without asking or checking."""
    return ({"content": "Done."}, {"tool_calls": [{"name": "Record", "arguments": output}]})


def owner(*answers, remote=""):
    """The owner for one accepted run: ``answers`` to the model's questions, "1" (create) to confirm, ``PASSWORD``
    twice, and ``remote`` typed (none when empty)."""
    return Script(*answers, "1", PASSWORD, PASSWORD, *((remote,) if remote else ("1",)))


def run(provider, prompter, known=Known()):
    return run_init_flow(provider, prompter, known)


MAX = yaml.safe_load(FLOW.read_text())["nodes"]["rounds"]["max"]


def contents(request):
    """Each message's content in a model request, as text."""
    return [m["content"] if isinstance(m["content"], str) else str(m["content"]) for m in request["messages"]]


def test_the_flow_takes_what_init_knows_and_the_remote_flag():
    flow = load_flow(FLOW.read_text(), source_label=str(FLOW))
    assert {p.name: p.contract.type.kind.value for p in flow.input} == {"known": "str", "remote": "str"}


def test_known_facts_are_the_given_flags_and_suggestions_but_never_the_remote(login):
    known = Known(company="Acme", agent_handle="bo", remote="https://user:secret@example.com/acme.git")
    assert known.facts() == {"given": {"company": "Acme", "agent_handle": "bo"},
                             "suggested": {"name": "Me", "handle": "me", "title": "CEO"}}


def test_without_flags_the_fallback_is_a_default_company(login):
    assert fallback_draft(Known()) == Draft("My company", Owner(handle="me", name="Me", title="CEO"),
                                            (Teammate("Minh", "minh", "Engineer"),))


def test_the_fallback_uses_every_flag(login):
    known = Known(company="Acme", name="Lan", handle="lan", title="CTO", agent="Bo", agent_handle="bo-1")
    assert fallback_draft(known) == Draft("Acme", Owner(handle="lan", name="Lan", title="CTO"),
                                          (Teammate("Bo", "bo-1", "Engineer"),))


def test_the_fallback_slugs_the_agents_name_for_a_handle(login):
    assert fallback_draft(Known(agent="Minh Anh")).team[0].handle == "minh-anh"
    assert fallback_draft(Known(agent="Đ")).team[0].handle == "agent"


def test_a_fallback_with_problems_names_the_flag_to_pass(login):
    with pytest.raises(OnboardError, match="@minh is taken; pass --agent-handle"):
        fallback_draft(Known(handle="minh"))
    with pytest.raises(OnboardError, match="@Me .*; pass --handle"):
        fallback_draft(Known(handle="Me"))


def test_the_summary_lists_the_company_you_and_each_teammate():
    assert summary(GOOD) == ["Company: Acme", "You: Hong Ngoc Bui (@ngocbh), CEO", "Teammates:",
                             "  Minh (@minh), Engineer: Writes the backend.", "  Lan (@lan), QA"]
    assert summary(Draft("Acme", ME, ()))[-1] == "Teammates: none yet"


def test_the_summary_strips_control_characters_from_model_text():
    answers = Draft("Ac\x1b[2Jme", Owner(handle="ngocbh", name="Hong\nNgoc\x07 Bui"),
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
        fallback_draft(Known(company="Acme", name="Lan", handle="lan", title="CTO", agent="Bo", agent_handle="bo"))


def test_the_interview_asks_on_the_terminal_and_returns_the_flows_output(login, fake_llm, provider):
    fake_llm.script(*flow_replies("What's the company called?", OUT))
    prompter = owner("Acme")
    out = run(provider, prompter)
    assert {k: out[k] for k in OUT} == OUT
    assert check_password(PASSWORD, out["password_hash"])
    assert out["remote"] == ""
    assert "What's the company called?" in prompter.seen
    assert "Acme" in contents(fake_llm.requests()[1])[-1]
    after = prompter.seen[prompter.seen.index(CONFIRM):]
    assert [line for line in after if line.startswith("Step ")] == ["Step 3 of 5: Password", "Step 4 of 5: Remote"]


@pytest.mark.parametrize("answer", ["2", "Founder"])
def test_a_question_with_options_is_a_list_with_a_way_to_type_an_answer(login, fake_llm, provider, answer):
    fake_llm.script(*flow_replies("Your title?", OUT, options=["CEO", "Founder"]))
    prompter = owner(answer)
    run(provider, prompter)
    assert prompter.seen[0] == "Your title?" and prompter.offered[0] == ["CEO", "Founder"] and prompter.typed[0] is True
    assert contents(fake_llm.requests()[1])[-1] == "Founder"


def test_a_typed_answer_to_a_question_with_options_goes_back_as_typed(login, fake_llm, provider):
    fake_llm.script(*flow_replies("Your title?", OUT, options=["CEO", "Founder"]))
    prompter = owner("Chair")
    run(provider, prompter)
    assert prompter.seen.count("Your title?") == 1
    assert contents(fake_llm.requests()[1])[-1] == "Chair"


def test_questions_and_options_are_asked_without_control_characters(login, fake_llm, provider):
    fake_llm.script(*flow_replies("Clear\x1b[2J?", OUT, options=["a\x9bb", "c"]))
    prompter = owner("2")
    run(provider, prompter)
    assert prompter.seen[0] == "Clear[2J?" and prompter.offered[0] == ["ab", "c"]


def test_an_option_goes_back_to_the_model_as_it_wrote_it(login, fake_llm, provider):
    fake_llm.script(*flow_replies("Pick?", OUT, options=["a\x9bb", "c"]))
    run(provider, owner("1"))
    assert contents(fake_llm.requests()[1])[-1] == "a\x9bb"


def test_a_long_option_is_offered_and_goes_back_whole():
    label = " ".join(["Keep the CI pipeline we have and add a nightly run"] * 4)
    prompter = Script("1")
    with asking(Asking(prompter)):
        assert ask_user(question="Which plan?", options=[label, "b"]) == label
    assert prompter.offered == [[label, "b"]] and prompter.typed == [True]


class Blank(Script):
    """A prompter whose lists give an empty answer, as an empty line does when there's no default."""

    def choose(self, question, options, default="", typed=False):
        self.seen.append(question)
        return ""


def test_an_answer_that_isnt_an_option_goes_back_as_typed(login, fake_llm, provider):
    fake_llm.script(*flow_replies("Pick?", OUT, options=["a", "b"]))
    run(provider, Blank(PASSWORD, PASSWORD, ""))
    assert contents(fake_llm.requests()[1])[-1] == ""


def test_the_providers_env_is_set_only_during_the_run(login, fake_llm, provider, monkeypatch):
    monkeypatch.delenv("VLLM_BASE_URL", raising=False)
    fake_llm.script(*flow_replies("Company?", OUT))
    run(provider, owner("Acme"))
    assert "VLLM_BASE_URL" not in os.environ
    assert len(fake_llm.requests()) == 4


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
    with pytest.raises(ModelError, match="couldn't run the interview"):
        run(provider, Script())
    assert len(fake_llm.requests()) == 1


def test_a_model_that_answers_has_no_problem(fake_llm, provider):
    fake_llm.script({"content": "OK"})
    assert model_problem(provider) is None
    assert len(fake_llm.requests()) == 1


def test_a_model_that_fails_says_why_without_the_key(fake_llm):
    fake_llm.script({"error": 401})
    problem = model_problem(Provider(llm_config={**LLM_CONFIG, "api_key": KEY}, env=fake_llm.env()))
    assert problem and KEY not in problem


def test_composers_unknown_model_warning_stays_off_the_terminal(login, monkeypatch, recwarn):
    def run_flow(*args, **kwargs):
        warnings.warn("Model 'gpt-prod' is not in the known model list for provider 'openai'. Continuing anyway.",
                      RuntimeWarning)
        raise RuntimeError("Connection error.")

    monkeypatch.setattr(interview_module, "run_flow", run_flow)
    with pytest.raises(ModelError) as caught:
        run(Provider(llm_config=LLM_CONFIG), Script())
    assert str(caught.value) == "the model couldn't run the interview: Connection error"
    assert len(recwarn) == 0


@pytest.mark.parametrize("outcome", ["result", "exception"])
def test_a_failure_message_never_shows_the_key_or_url_credentials(login, monkeypatch, outcome):
    message = f"bad key {KEY} for https://user:hunter2@example.com/v1"

    def run_flow(*args, **kwargs):
        if outcome == "exception":
            raise RuntimeError(message)
        return SimpleNamespace(status="failed", output=None, failure=SimpleNamespace(message=message, cause_type=None))

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

    def choose(self, question, options, default="", typed=False):
        self.seen.append(question)
        raise self.error


def test_when_the_owners_input_ends_its_error_stops_the_interview(login, fake_llm, provider):
    fake_llm.script(*flow_replies("Company?", OUT))
    with pytest.raises(OnboardError) as caught:
        run(provider, Closed())
    assert caught.value is Closed.error
    assert len(fake_llm.requests()) == 1


def test_the_model_is_told_what_is_known(login, fake_llm, provider):
    fake_llm.script(*flow_replies("Company?", OUT))
    run(provider, owner("Acme"), Known(company="Acme"))
    text = "\n".join(contents(fake_llm.requests()[0]))
    assert '"given": {"company": "Acme"}' in text


def confirming(*replies):
    state = Asking(Script(*replies))
    return state, asking(state)


def test_confirm_shows_the_clean_draft_and_accepts_on_yes():
    state, ctx = confirming("")
    with ctx:
        assert confirm({"answers": OUT}) == {"draft": json.dumps(OUT), "changes": "", "accepted": True}
    assert state.prompter.seen == [*summary(Draft.from_output(OUT)), CONFIRM]
    assert state.prompter.offered == [[CREATE, CHANGE]]


def bad_output(handle="Minh"):
    return {**OUT, "teammates": [{**OUT["teammates"][0], "handle": handle}]}


def test_confirm_sends_problems_back_without_asking_the_owner():
    state, ctx = confirming()
    with ctx:
        result = confirm({"answers": bad_output()})
    assert result == {"draft": json.dumps(bad_output()),
                      "changes": "\n".join(draft_problems(Draft.from_output(bad_output()))), "accepted": False}
    assert state.prompter.seen == []


@pytest.mark.parametrize("pick", ["2", CHANGE])
def test_confirm_turns_the_owners_change_into_changes(pick):
    state, ctx = confirming(pick, "rename Minh to Bo")
    with ctx:
        assert confirm({"answers": OUT}) == {"draft": json.dumps(OUT), "accepted": False,
                                             "changes": "The owner wants changes: rename Minh to Bo"}
    assert state.prompter.seen[-2:] == [CONFIRM, WHAT_TO_CHANGE]


def test_no_change_given_asks_the_model_to_ask():
    _, ctx = confirming("2", "")
    with ctx:
        assert confirm({"answers": OUT}) == {"draft": json.dumps(OUT), "accepted": False,
                                             "changes": "The owner wants changes; ask what to change"}


def test_an_onboard_error_inside_owner_prompter_is_kept_for_the_caller():
    state = Asking(Closed())
    with asking(state), pytest.raises(OnboardError):
        confirm({"answers": OUT})
    assert state.stopped is Closed.error


def test_the_interview_offers_a_handle_made_from_the_name_as_an_option():
    prompt = yaml.safe_load(FLOW.read_text())["nodes"]["rounds"]["nodes"]["interview"]["prompt"]
    assert "Offer one made from the person's name as an option, such as" in " ".join(prompt.split())


def test_no_agent_node_reads_the_password_or_the_remote():
    def agents(nodes):
        for node in nodes.values():
            if node["kind"] == "agent":
                yield node
            yield from agents(node.get("nodes", {}))

    for node in agents(yaml.safe_load(FLOW.read_text())["nodes"]):
        inputs = json.dumps(node["input"])
        assert "password" not in inputs and "remote" not in inputs


def test_the_tools_problems_go_back_to_the_model(login, fake_llm, provider):
    bad = bad_output()
    partial = {"company": "Acme", "owner": OUT["owner"], "teammates": [{"name": "Lan", "handle": "lan"}]}
    fake_llm.script({"tool_calls": [{"name": "check_company", "arguments": bad}]},  # its "about"s are ignored
                    {"tool_calls": [{"name": "check_company", "arguments": partial}]},  # no title yet
                    *round_replies(OUT))
    run(provider, owner())
    reply = contents(fake_llm.requests()[1])[-1]
    assert reply.startswith("Problems; ask the owner") and "@Minh can't be a handle" in reply
    assert "the teammate @lan needs a title" in contents(fake_llm.requests()[2])[-1]


def test_a_result_with_problems_goes_back_to_the_interview_without_asking_the_owner(login, fake_llm, provider):
    fake_llm.script(*round_replies(bad_output()), *round_replies(OUT))
    prompter = owner()
    assert run(provider, prompter)["teammates"] == OUT["teammates"]
    assert prompter.seen.count(CONFIRM) == 1
    second = "\n".join(contents(fake_llm.requests()[2]))
    assert "@Minh can't be a handle" in second and '"handle": "Minh"' in second


def test_the_owners_changes_start_the_next_round_from_the_draft(login, fake_llm, provider):
    renamed = {**OUT, "teammates": [{**OUT["teammates"][0], "name": "Bo", "handle": "bo"}]}
    fake_llm.script(*flow_replies("Company?", OUT), *round_replies(renamed))
    out = run(provider, Script("Acme", "2", "rename Minh to Bo", "1", PASSWORD, PASSWORD, "1"))
    assert out["teammates"] == renamed["teammates"]
    second = "\n".join(contents(fake_llm.requests()[4]))
    assert '"name": "Minh"' in second and "The owner wants changes: rename Minh to Bo" in second


def test_the_flow_gives_up_after_max_rounds(login, fake_llm, provider):
    fake_llm.script(*[r for _ in range(MAX) for r in round_replies(bad_output())])
    prompter = Script()
    with pytest.raises(OnboardError, match="didn't settle on a company; run `ac init` again"):
        run(provider, prompter)
    assert len(fake_llm.requests()) == 2 * MAX and prompter.seen == []


def test_when_the_input_ends_at_the_confirmation_its_error_stops_the_flow(login, fake_llm, provider):
    fake_llm.script(*round_replies(OUT))
    with pytest.raises(OnboardError) as caught:
        run(provider, Closed())
    assert caught.value is Closed.error


def test_no_usable_password_stops_the_flow_with_that_error(login, fake_llm, provider):
    fake_llm.script(*round_replies(OUT))
    with pytest.raises(OnboardError, match="^no usable password$"):
        run(provider, Script("1", *["short"] * TRIES))


class InterruptedAtPassword(Script):
    def secret(self, question):
        raise KeyboardInterrupt


def test_ctrl_c_at_the_password_stops_the_flow_and_restores_the_env(login, fake_llm, provider):
    before = dict(os.environ)
    fake_llm.script(*round_replies(OUT))
    with pytest.raises(KeyboardInterrupt):
        run(provider, InterruptedAtPassword("1"))
    assert dict(os.environ) == before
    assert interview_module._ASKING.get(None) is None


def test_the_remote_flag_is_used_without_asking_and_never_sent(login, fake_llm, provider):
    url = "https://user:tok-sentinel-77@example.com/acme.git"
    fake_llm.script(*round_replies(OUT))
    prompter = Script("1", PASSWORD, PASSWORD)
    assert run(provider, prompter, Known(remote=url))["remote"] == url
    assert REMOTE not in prompter.seen
    assert "tok-sentinel-77" not in json.dumps(fake_llm.requests())


def test_init_flow_gives_the_draft_with_the_hash_and_the_remote_apart(login, fake_llm, provider, tmp_path):
    path = tmp_path / "provider.json"
    path.write_text(json.dumps({"llm_config": provider.llm_config, "env": provider.env}))
    path.chmod(0o600)
    fake_llm.script(*round_replies(OUT))
    draft, url = init_flow(path, owner(remote="git@example.com:a.git"), Known())
    assert draft.company == "Acme" and check_password(PASSWORD, draft.owner.password_hash)
    assert url == "git@example.com:a.git"


@pytest.mark.parametrize(("known", "flag"), [
    (Known(company=" "), "--company"), (Known(name=" "), "--name"), (Known(handle="Me"), "--handle"),
    (Known(agent=" "), "--agent"), (Known(agent_handle="Bad_Handle"), "--agent-handle")])
def test_each_fallback_problem_names_the_flag_that_sets_its_field(login, known, flag):
    with pytest.raises(OnboardError, match=f"; pass {flag}$"):
        fallback_draft(known)

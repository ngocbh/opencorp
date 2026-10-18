import io
import json

import pytest

from opencorp.install.json_prompts import JsonPrompter
from opencorp.install.onboard import OnboardError


def _prompter(*answers: str, preset=None) -> tuple[JsonPrompter, io.StringIO]:
    out = io.StringIO()
    stdin = io.StringIO("".join(json.dumps({"answer": a}) + "\n" for a in answers))
    return JsonPrompter(out, stdin, preset), out


def _sent(out: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in out.getvalue().splitlines()]


def test_ask_sends_the_question_and_returns_the_answer():
    prompter, out = _prompter("Acme")
    assert prompter.ask("Company", "Default Co") == "Acme"
    assert _sent(out) == [{"type": "ask", "question": "Company", "default": "Default Co"}]


def test_an_empty_answer_is_the_default():
    prompter, _ = _prompter("  ")
    assert prompter.ask("Company", "Default Co") == "Default Co"


def test_choose_returns_one_of_the_options():
    prompter, out = _prompter("openai")
    assert prompter.choose("Model provider", ["anthropic", "openai"], "anthropic") == "openai"
    assert _sent(out) == [{"type": "choose", "question": "Model provider", "options": ["anthropic", "openai"],
                           "default": "anthropic", "typed": False}]


def test_an_empty_choice_is_the_default():
    prompter, _ = _prompter("")
    assert prompter.choose("Model provider", ["anthropic", "openai"], "openai") == "openai"


def test_choose_refuses_an_answer_that_isnt_an_option():
    prompter, _ = _prompter("gemini")
    with pytest.raises(OnboardError, match="isn't one of"):
        prompter.choose("Model provider", ["anthropic", "openai"])


FIRST = "claude-sonnet-4-5 (the default)"


def test_a_typed_choice_says_so_and_takes_typed_text():
    prompter, out = _prompter(" claude-opus-4-1 ")
    assert prompter.choose("Model", [FIRST], FIRST, typed=True) == "claude-opus-4-1"
    assert _sent(out) == [{"type": "choose", "question": "Model", "options": [FIRST], "default": FIRST,
                           "typed": True}]


def test_a_typed_choice_still_returns_an_option_and_takes_the_default_for_nothing():
    prompter, _ = _prompter("None for now", "  ")
    assert prompter.choose("Remote", ["None for now"], "None for now", typed=True) == "None for now"
    assert prompter.choose("Remote", ["None for now"], "my-model", typed=True) == "my-model"


def test_a_long_option_is_sent_and_returned_whole():
    label = " ".join(["Keep the CI pipeline we have and add a nightly run"] * 4)
    assert len(label) > 200
    prompter, out = _prompter(label)
    assert prompter.choose("Plan", [label, "b"], typed=True) == label
    assert _sent(out)[0]["options"][0] == label


def test_secret_is_asked_without_a_default_and_stripped():
    prompter, out = _prompter(" sk-ant-sentinel-a7d93c10e5b2\n")
    assert prompter.secret("API key") == "sk-ant-sentinel-a7d93c10e5b2"
    assert _sent(out) == [{"type": "secret", "question": "API key"}]


def test_say_and_step_need_no_answer():
    prompter, out = _prompter()
    prompter.step(1, 5, "Model", "Why it matters")
    prompter.say("Saved")
    assert _sent(out) == [{"type": "step", "number": 1, "total": 5, "title": "Model", "why": "Why it matters"},
                          {"type": "say", "text": "Saved"}]


def test_a_preset_answer_asks_nothing():
    prompter, out = _prompter(preset={"Which human are you?": "ngocbh"})
    assert prompter.ask("Which human are you?") == "ngocbh"
    assert out.getvalue() == ""


def test_stdin_closing_before_an_answer_is_an_onboard_error():
    prompter, _ = _prompter()
    with pytest.raises(OnboardError, match="stdin closed"):
        prompter.ask("Company")


def test_a_line_that_isnt_an_answer_is_an_onboard_error_without_its_text():
    prompter = JsonPrompter(io.StringIO(), io.StringIO("sk-ant-sentinel-a7d93c10e5b2\n"))
    with pytest.raises(OnboardError) as caught:
        prompter.secret("API key")
    assert "sentinel" not in str(caught.value)

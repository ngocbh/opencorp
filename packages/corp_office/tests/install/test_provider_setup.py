import getpass
import io
import json
import os
import stat

import sys

import pytest
from prompt_toolkit.data_structures import Size
from prompt_toolkit.input import create_pipe_input
from prompt_toolkit.output import DummyOutput
from prompt_toolkit.output.vt100 import Vt100_Output

from agent_corp.chat.provider import load_provider
from agent_corp.install.onboard import TRIES, NoTerminal, OnboardError, TtyPrompter, ensure_provider, step_lines

KEY = "sk-ant-test-0123456789"


class Script:
    """A prompter that answers from a list and records everything it was asked or told."""

    def __init__(self, *answers, interactive=True):
        self.answers = list(answers)
        self.interactive = interactive
        self.seen: list[str] = []
        self.offered: list[list[str]] = []
        """The options of each ``choose``, in order."""

    def ask(self, question, default=""):
        self.seen.append(question)
        answer = self.answers.pop(0)
        return answer or default

    def choose(self, question, options, default=""):
        """The default for an empty answer, an option given exactly, or the option a number picks (from 1)."""
        self.seen.append(question)
        self.offered.append(list(options))
        answer = self.answers.pop(0)
        if not answer:
            return default
        if answer in options:
            return answer
        if answer.isdecimal() and 1 <= int(answer) <= len(options):
            return options[int(answer) - 1]
        raise AssertionError(f"{answer!r} isn't an answer to {question!r}; the options are {list(options)}")

    def secret(self, question):
        self.seen.append(question)
        return self.answers.pop(0)

    def say(self, text):
        self.seen.append(text)

    def step(self, number, total, title, why):
        self.seen.extend(step_lines(number, total, title, why))


def mode(path):
    return stat.S_IMODE(os.lstat(path).st_mode)


def test_a_script_is_interactive_unless_told_otherwise():
    assert Script("x").interactive is True
    assert Script(interactive=False).interactive is False


def test_the_key_is_asked_without_echo_and_written_private(tmp_path):
    path = tmp_path / "provider.json"
    ask = Script("", "claude-sonnet-4-5", KEY)
    assert ensure_provider(path, ask) is True
    assert mode(path) == 0o600
    assert json.loads(path.read_text()) == {"llm_config": {"provider": "anthropic", "model": "claude-sonnet-4-5",
                                                           "api_key": KEY}}
    assert load_provider(path).llm_config["api_key"] == KEY
    assert all(KEY not in line for line in ask.seen)
    assert os.listdir(tmp_path) == ["provider.json"]  # no temp file left behind


def test_no_key_means_composers_own_login(tmp_path):
    path = tmp_path / "provider.json"
    ask = Script("openai", "", "")
    ensure_provider(path, ask)
    assert json.loads(path.read_text()) == {"llm_config": {"provider": "openai"}}
    assert any("composer auth" in line for line in ask.seen)


def test_a_key_in_the_environment_is_never_read(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", KEY)
    path = tmp_path / "provider.json"
    ensure_provider(path, Script("anthropic", "", ""))
    assert KEY not in path.read_text() and "api_key" not in json.loads(path.read_text())["llm_config"]


def test_an_unknown_provider_is_asked_again(tmp_path):
    ask = Script("antrhopic", "anthropic", "", "")
    ensure_provider(tmp_path / "provider.json", ask)
    assert any("one of" in line and "anthropic" in line for line in ask.seen)


def test_a_misspelled_setting_is_refused_without_echoing_the_key(tmp_path):
    with pytest.raises(OnboardError, match="an extra field; the fields are provider, model") as info:
        ensure_provider(tmp_path / "provider.json", Script(), stdin=io.StringIO(json.dumps(
            {"llm_config": {"provider": "anthropic", "api_key": KEY, "temprature": 1}})))
    assert KEY not in str(info.value) and not (tmp_path / "provider.json").exists()


def test_a_key_pasted_as_a_field_name_is_not_echoed(tmp_path):
    for data in ({"llm_config": {"provider": "anthropic", KEY: 1}}, {KEY: 1}, {"llm_config": {"model": 1, "api_key": KEY}}):
        with pytest.raises(OnboardError) as info:
            ensure_provider(tmp_path / "provider.json", Script(), stdin=io.StringIO(json.dumps(data)))
        assert KEY not in str(info.value)


def test_a_key_needs_a_provider(tmp_path):
    with pytest.raises(OnboardError, match="needs llm_config.provider") as info:
        ensure_provider(tmp_path / "provider.json", Script(), stdin=io.StringIO(json.dumps(
            {"llm_config": {"api_key": KEY}})))
    assert KEY not in str(info.value)


def test_a_base_url_beside_the_key_is_saved(tmp_path):
    path = tmp_path / "provider.json"
    llm = {"provider": "openai", "model": "gpt-5.4", "base_url": "https://acme.openai.azure.com/openai/v1/",
           "api_key": KEY}
    assert ensure_provider(path, Script(), stdin=io.StringIO(json.dumps({"llm_config": llm}))) is True
    assert load_provider(path).llm_config == llm and mode(path) == 0o600


@pytest.mark.parametrize("llm, error", [
    ({"provider": "openai", "base_url": "http://gateway.example.com/v1", "api_key": KEY}, "must use https"),
    ({"provider": "openai", "base_url": "https://gateway.example.com/v1"}, "base_url needs llm_config.api_key"),
    ({"provider": "azure", "base_url": "https://gateway.example.com/v1", "api_key": KEY},
     "azure does not take llm_config.base_url"),
])
def test_a_base_url_composer_refuses_is_refused_without_echoing_it_or_the_key(tmp_path, llm, error):
    with pytest.raises(OnboardError, match=error) as info:
        ensure_provider(tmp_path / "provider.json", Script(), stdin=io.StringIO(json.dumps({"llm_config": llm})))
    assert KEY not in str(info.value) and "gateway.example.com" not in str(info.value)
    assert not (tmp_path / "provider.json").exists()


def test_a_credential_in_env_is_refused_without_its_value(tmp_path):
    with pytest.raises(OnboardError, match="ANTHROPIC_API_KEY") as info:
        ensure_provider(tmp_path / "provider.json", Script(), stdin=io.StringIO(json.dumps(
            {"env": {"ANTHROPIC_API_KEY": KEY}})))
    assert KEY not in str(info.value)


def test_stdin_that_isnt_json_is_refused_without_echo(tmp_path):
    with pytest.raises(OnboardError, match="not valid JSON") as info:
        ensure_provider(tmp_path / "provider.json", Script(), stdin=io.StringIO(f'{{"llm_config": {KEY}'))
    assert KEY not in str(info.value)


def test_an_existing_provider_is_kept_and_nothing_is_asked(tmp_path):
    path = tmp_path / "provider.json"
    path.write_text('{"llm_config": {"provider": "openai"}}\n')
    path.chmod(0o600)
    before = path.stat()
    ask = Script()
    assert ensure_provider(path, ask) is False
    assert path.stat().st_mtime_ns == before.st_mtime_ns and ask.seen == []


def test_a_provider_on_stdin_replaces_an_existing_one(tmp_path):
    path = tmp_path / "provider.json"
    old = "sk-ant-old-key-9f8e7d6c5b4a"
    ensure_provider(path, Script(), stdin=io.StringIO(json.dumps({"llm_config": {"provider": "anthropic", "api_key": old}})))
    ask = Script()
    assert ensure_provider(path, ask, stdin=io.StringIO(json.dumps(
        {"llm_config": {"provider": "anthropic", "api_key": KEY}}))) is True
    assert load_provider(path).llm_config["api_key"] == KEY and old not in path.read_text()
    assert mode(path) == 0o600 and os.listdir(tmp_path) == ["provider.json"] and ask.seen == []


def test_a_bad_provider_on_stdin_leaves_the_existing_one(tmp_path):
    path = tmp_path / "provider.json"
    path.write_text('{"llm_config": {"provider": "openai"}}\n')
    path.chmod(0o600)
    with pytest.raises(OnboardError, match="not valid JSON"):
        ensure_provider(path, Script(), stdin=io.StringIO("{"))
    assert path.read_text() == '{"llm_config": {"provider": "openai"}}\n'


def test_an_existing_provider_others_can_read_is_an_error_and_left_alone(tmp_path):
    path = tmp_path / "provider.json"
    path.write_text("{}\n")
    path.chmod(0o644)
    with pytest.raises(OnboardError, match="0600"):
        ensure_provider(path, Script())
    assert path.read_text() == "{}\n" and mode(path) == 0o644


def test_an_existing_provider_composer_wont_take_is_an_error_without_the_key(tmp_path):
    path = tmp_path / "provider.json"
    path.write_text(json.dumps({"llm_config": {"provider": "anthropic", "api_key": KEY, "temprature": 1}}))
    path.chmod(0o600)
    with pytest.raises(OnboardError, match="an extra field; the fields are provider, model") as info:
        ensure_provider(path, Script())
    assert KEY not in str(info.value)


def test_a_symlink_where_the_provider_goes_is_refused(tmp_path):
    (tmp_path / "provider.json").symlink_to(tmp_path / "elsewhere")
    with pytest.raises(OnboardError):
        ensure_provider(tmp_path / "provider.json", Script("openai", "", ""))
    assert not (tmp_path / "elsewhere").exists()


def test_the_terminal_prompter_wont_read_a_key_without_a_terminal(monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO(KEY + "\n"))
    monkeypatch.setattr(getpass, "getpass", lambda *a, **k: pytest.fail("getpass would echo without a tty"))
    for prompter in (TtyPrompter(), TtyPrompter(interactive=False)):
        with pytest.raises(NoTerminal) as info:
            prompter.secret("anthropic API key")
        assert KEY not in str(info.value)


def test_a_key_asked_for_without_a_terminal_says_to_pass_the_provider_on_stdin(tmp_path, monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO(KEY + "\n"))
    with pytest.raises(OnboardError, match="--provider-stdin") as info:
        ensure_provider(tmp_path / "provider.json", TtyPrompter({"Model provider": "anthropic"}, interactive=False))
    assert KEY not in str(info.value) and not isinstance(info.value, NoTerminal)


def test_the_terminal_prompter_takes_presets_and_defaults():
    prompter = TtyPrompter({"Company name": "Acme", "Your name": ""}, interactive=False)
    assert prompter.ask("Company name", "My company") == "Acme"
    assert prompter.ask("Your name", "Me") == "Me"


@pytest.fixture
def terminal():
    """A terminal for questionary: keys sent to its input are read as typed, and what it draws is thrown away."""
    with create_pipe_input() as keys:
        yield keys, DummyOutput()


DOWN, ENTER, CTRL_C = "\x1b[B", "\r", "\x03"


def test_a_list_on_a_terminal_is_picked_with_the_arrow_keys(terminal):
    terminal[0].send_text(DOWN + ENTER)
    assert TtyPrompter(terminal=terminal).choose("Q", ["a", "b", "c"]) == "b"


def test_a_list_on_a_terminal_starts_at_its_default(terminal):
    terminal[0].send_text(ENTER)
    assert TtyPrompter(terminal=terminal).choose("Q", ["a", "b", "c"], "c") == "c"


def test_a_default_that_isnt_an_option_starts_the_list_at_the_top(terminal):
    terminal[0].send_text(ENTER)
    assert TtyPrompter(terminal=terminal).choose("Q", ["a", "b"], "zzz") == "a"


@pytest.mark.parametrize("typed, default, answer", [("Acme" + ENTER, "", "Acme"), (ENTER, "Mine", "Mine")])
def test_a_question_on_a_terminal_takes_typed_text_or_its_default(terminal, typed, default, answer):
    terminal[0].send_text(typed)
    assert TtyPrompter(terminal=terminal).ask("Q", default) == answer


@pytest.mark.parametrize("call", [lambda p: p.choose("Q", ["a"]), lambda p: p.ask("Q")])
def test_ctrl_c_on_a_terminal_is_a_keyboard_interrupt(terminal, call):
    terminal[0].send_text(CTRL_C)
    with pytest.raises(KeyboardInterrupt):
        call(TtyPrompter(terminal=terminal))


@pytest.mark.parametrize("call", [lambda p: p.choose("Q", ["a"]), lambda p: p.ask("Q")])
def test_closed_input_on_a_terminal_is_an_onboard_error(terminal, call):
    terminal[0].close()
    with pytest.raises(OnboardError, match=r"no answer to 'Q' \(stdin closed\)"):
        call(TtyPrompter(terminal=terminal))


def test_a_preset_picks_from_a_list_without_asking():
    assert TtyPrompter({"Q": "b"}).choose("Q", ["a", "b"], "a") == "b"


@pytest.mark.parametrize("default", ["", "b"])
def test_without_anyone_to_ask_a_list_gives_its_default_even_on_a_terminal(terminal, default):
    terminal[0].send_text(DOWN + ENTER)
    assert TtyPrompter(interactive=False, terminal=terminal).choose("Q", ["a", "b"], default) == default


def colours(monkeypatch, no_color):
    """What a list draws on a real terminal, with ``NO_COLOR`` set or not when the prompter is made."""
    monkeypatch.delenv("TERM", raising=False)
    if no_color:
        monkeypatch.setenv("NO_COLOR", "1")
    else:
        monkeypatch.delenv("NO_COLOR", raising=False)
    drawn = io.StringIO()
    with create_pipe_input() as keys:
        prompter = TtyPrompter(terminal=(keys, Vt100_Output(drawn, lambda: Size(24, 80), term="xterm")))
        monkeypatch.setenv("NO_COLOR", "1")  # the init flow's environment changes after the prompter is made
        keys.send_text(ENTER)
        prompter.choose("Q", ["a", "b"])
    return drawn.getvalue()


def test_a_list_is_coloured_unless_no_color_was_set(monkeypatch):
    assert "\x1b[0;36;1m?" in colours(monkeypatch, no_color=False)
    plain = colours(monkeypatch, no_color=True)
    assert "?" in plain and ";36" not in plain


def plain_stdin(monkeypatch, text):
    """Make stdin ``text``, read line by line as from a pipe."""
    monkeypatch.setattr(sys, "stdin", io.StringIO(text))


@pytest.mark.parametrize("line, answer", [("2", "b"), ("b", "b"), ("", "a")])
def test_without_a_terminal_a_list_is_numbered_and_takes_a_number_an_option_or_nothing(monkeypatch, capsys, line,
                                                                                         answer):
    plain_stdin(monkeypatch, line + "\n")
    assert TtyPrompter().choose("Q", ["a", "b"], "a") == answer
    out = capsys.readouterr().out
    assert "  1. a\n" in out and "  2. b\n" in out


def test_without_a_terminal_an_option_is_taken_before_a_number(monkeypatch):
    plain_stdin(monkeypatch, "1\n")
    assert TtyPrompter().choose("Q", ["3", "2", "1"]) == "1"


def test_without_a_terminal_nothing_with_no_default_is_empty(monkeypatch):
    plain_stdin(monkeypatch, "\n")
    assert TtyPrompter().choose("Q", ["a", "b"]) == ""


def test_without_a_terminal_a_bad_answer_is_asked_again(monkeypatch, capsys):
    plain_stdin(monkeypatch, "x\n3\n2\n")
    assert TtyPrompter().choose("Q", ["a", "b"]) == "b"
    assert capsys.readouterr().out.count("That doesn't work: choose 1 to 2") == 2


def test_without_a_terminal_bad_answers_give_up(monkeypatch):
    plain_stdin(monkeypatch, "x\n" * TRIES + "2\n")
    with pytest.raises(OnboardError, match="no usable answer to 'Q'"):
        TtyPrompter().choose("Q", ["a", "b"])


def test_without_a_terminal_closed_input_is_an_onboard_error(monkeypatch):
    plain_stdin(monkeypatch, "")
    with pytest.raises(OnboardError, match=r"no answer to 'Q' \(stdin closed\)"):
        TtyPrompter().choose("Q", ["a", "b"])


def test_the_script_prompter_picks_by_option_number_or_default():
    ask = Script("", "b", "1", "2")
    assert [ask.choose("Q", ("a", "b"), "x") for _ in range(4)] == ["x", "b", "a", "b"]
    assert ask.seen == ["Q"] * 4 and ask.offered == [["a", "b"]] * 4


def test_the_script_prompter_fails_on_an_answer_that_isnt_an_option():
    with pytest.raises(AssertionError, match=r"'c' isn't an answer to 'Q'; the options are \['a', 'b'\]"):
        Script("c").choose("Q", ["a", "b"])
    with pytest.raises(AssertionError, match="'3' isn't"):
        Script("3").choose("Q", ["a", "b"])


def test_the_terminal_prompter_shows_a_step_as_a_header_and_why(capsys):
    TtyPrompter().step(2, 5, "You", "You're the CEO.")
    assert capsys.readouterr().out == "\nStep 2 of 5: You\nYou're the CEO.\n"


def test_the_script_prompter_records_the_same_step_lines():
    ask = Script()
    ask.step(1, 4, "Company", "Why.")
    assert ask.seen == step_lines(1, 4, "Company", "Why.") == ["Step 1 of 4: Company", "Why."]


def test_a_directory_where_the_provider_goes_is_an_onboard_error(tmp_path):
    (tmp_path / "provider.json").mkdir()
    with pytest.raises(OnboardError, match="provider.json") as info:
        ensure_provider(tmp_path / "provider.json", Script(), stdin=io.StringIO(
            json.dumps({"llm_config": {"provider": "anthropic", "api_key": KEY}})))
    assert KEY not in str(info.value)
    assert os.listdir(tmp_path) == ["provider.json"]  # no temp file left
    with pytest.raises(OnboardError, match="provider.json"):
        ensure_provider(tmp_path / "provider.json", Script())

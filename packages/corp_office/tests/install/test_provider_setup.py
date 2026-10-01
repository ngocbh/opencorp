import getpass
import io
import json
import os
import stat

import pytest

from agent_corp.chat.provider import load_provider
from agent_corp.install.onboard import OnboardError, TtyPrompter, ensure_provider

KEY = "sk-ant-test-0123456789"


class Script:
    """A prompter that answers from a list and records everything it was asked or told."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.seen: list[str] = []

    def ask(self, question, default=""):
        self.seen.append(question)
        answer = self.answers.pop(0)
        return answer or default

    def secret(self, question):
        self.seen.append(question)
        return self.answers.pop(0)

    def say(self, text):
        self.seen.append(text)


def mode(path):
    return stat.S_IMODE(os.lstat(path).st_mode)


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
        with pytest.raises(OnboardError, match="--provider-stdin") as info:
            prompter.secret("anthropic API key")
        assert KEY not in str(info.value)


def test_the_terminal_prompter_takes_presets_and_defaults():
    prompter = TtyPrompter({"Company name": "Acme", "Your name": ""}, interactive=False)
    assert prompter.ask("Company name", "My company") == "Acme"
    assert prompter.ask("Your name", "Me") == "Me"


def test_a_directory_where_the_provider_goes_is_an_onboard_error(tmp_path):
    (tmp_path / "provider.json").mkdir()
    with pytest.raises(OnboardError, match="provider.json") as info:
        ensure_provider(tmp_path / "provider.json", Script(), stdin=io.StringIO(
            json.dumps({"llm_config": {"provider": "anthropic", "api_key": KEY}})))
    assert KEY not in str(info.value)
    assert os.listdir(tmp_path) == ["provider.json"]  # no temp file left
    with pytest.raises(OnboardError, match="provider.json"):
        ensure_provider(tmp_path / "provider.json", Script())

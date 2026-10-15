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

from yian.llm_clients.config import SUPPORTED_LLM_PROVIDERS

from agent_corp.chat.models import ModelListError
from agent_corp.chat.provider import load_provider
from agent_corp.install import onboard as onboard_module
from agent_corp.install.onboard import (SET_UP_AGAIN, TRIES, TRY_AGAIN, TYPE_OWN, NoTerminal, OnboardError,
                                        TtyPrompter, azure_deployments, ensure_provider, provider_models, step_lines)

KEY = "sk-ant-test-0123456789"
SENTINEL = "sk-ant-sentinel-a7d93c10e5b2"


class Script:
    """A prompter that answers from a list and records everything it was asked or told."""

    def __init__(self, *answers, interactive=True):
        self.answers = list(answers)
        self.interactive = interactive
        self.seen: list[str] = []
        self.offered: list[list[str]] = []
        """The options of each ``choose``, in order."""
        self.typed: list[bool] = []
        """Whether each ``choose`` took a typed answer, in order."""

    def ask(self, question, default=""):
        self.seen.append(question)
        answer = self.answers.pop(0)
        return answer or default

    def choose(self, question, options, default="", typed=False):
        """The default for an empty answer, an option given exactly, the option a number picks (from 1), or with
        ``typed`` any other text."""
        self.seen.append(question)
        self.offered.append(list(options))
        self.typed.append(typed)
        answer = self.answers.pop(0)
        if not answer:
            return default
        if answer in options:
            return answer
        if answer.isdecimal() and 1 <= int(answer) <= len(options):
            return options[int(answer) - 1]
        if typed:
            return answer
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
    ask = Script("", KEY, "claude-opus-4-1")
    assert ensure_provider(path, ask) is True
    assert mode(path) == 0o600
    assert json.loads(path.read_text()) == {"llm_config": {"provider": "anthropic", "api_key": KEY,
                                                           "model": "claude-opus-4-1"}}
    assert load_provider(path).llm_config["api_key"] == KEY
    assert all(KEY not in line for line in ask.seen)
    assert os.listdir(tmp_path) == ["provider.json"]  # no temp file left behind
    assert ask.seen == ["Model provider", "anthropic API key (empty to use `yian auth anthropic`; not shown)",
                        "Model"]
    assert ask.offered == [list(SUPPORTED_LLM_PROVIDERS), ["claude-sonnet-4-5 (the default)"]]
    assert ask.typed == [False, True]


def test_no_key_and_no_model_name_means_the_model_yians_login_saved(tmp_path):
    path = tmp_path / "provider.json"
    ensure_provider(path, Script("openai", "", "  "))
    assert json.loads(path.read_text()) == {"llm_config": {"provider": "openai"}}


def test_picking_the_default_saves_its_name(tmp_path):
    # Yian has no default model, so the file names it.
    path = tmp_path / "provider.json"
    ensure_provider(path, Script("openai", KEY, "1"))
    assert json.loads(path.read_text()) == {"llm_config": {"provider": "openai", "api_key": KEY, "model": "gpt-5.5"}}


def test_a_provider_on_stdin_with_a_key_and_no_model_is_saved_with_the_default(tmp_path):
    path = tmp_path / "provider.json"
    data = {"llm_config": {"provider": "anthropic", "api_key": KEY}}
    assert ensure_provider(path, Script(), stdin=io.StringIO(json.dumps(data))) is True
    assert json.loads(path.read_text())["llm_config"]["model"] == "claude-sonnet-4-5"


def test_an_existing_provider_with_a_key_and_no_model_gets_the_default_written(tmp_path):
    path = tmp_path / "provider.json"
    path.write_text(json.dumps({"llm_config": {"provider": "openai", "api_key": KEY}}))
    path.chmod(0o600)
    assert ensure_provider(path, Script(interactive=False)) is True
    assert json.loads(path.read_text()) == {"llm_config": {"provider": "openai", "api_key": KEY, "model": "gpt-5.5"}}
    assert mode(path) == 0o600
    assert ensure_provider(path, Script(interactive=False)) is False


def test_a_provider_without_a_default_model_asks_for_one_until_it_has_it(tmp_path):
    path = tmp_path / "provider.json"
    ask = Script("google", KEY, "", "gemini-2.5-pro")
    ensure_provider(path, ask)
    assert json.loads(path.read_text()) == {"llm_config": {"provider": "google", "api_key": KEY,
                                                           "model": "gemini-2.5-pro"}}
    assert ask.offered == [list(SUPPORTED_LLM_PROVIDERS)]
    assert ask.seen.count("Model name (google has no default model)") == 2
    assert "That doesn't work: type the model's name" in ask.seen


@pytest.mark.parametrize("endpoint", ["acme", "acme.openai.azure.com", "https://acme.openai.azure.com/",
                                      " https://acme.openai.azure.com/openai/v1/ "])
def test_azure_is_saved_as_openai_on_the_resources_v1_endpoint(tmp_path, endpoint):
    path = tmp_path / "provider.json"
    ask = Script("azure", endpoint, KEY, "gpt-5-4-prod")
    assert ensure_provider(path, ask) is True
    assert json.loads(path.read_text()) == {"llm_config": {
        "provider": "openai", "base_url": "https://acme.openai.azure.com/openai/v1/", "api_key": KEY,
        "model": "gpt-5-4-prod"}}
    assert ask.seen == ["Model provider", "Azure OpenAI endpoint or resource name", "azure API key (not shown)",
                        "Deployment name"]


def test_azure_offers_the_resources_deployments(tmp_path, monkeypatch):
    path = tmp_path / "provider.json"
    seen = []
    monkeypatch.setattr(onboard_module, "azure_deployments",
                        lambda base_url, key: seen.append((base_url, key)) or ["gpt-5.4", "o3"])
    ask = Script("azure", "acme", KEY, "2")
    ensure_provider(path, ask)
    assert load_provider(path).llm_config["model"] == "o3"
    assert seen == [("https://acme.openai.azure.com/openai/v1/", KEY)]
    assert ["gpt-5.4", "o3"] in ask.offered and True in ask.typed


def test_azure_takes_a_typed_deployment_too(tmp_path, monkeypatch):
    path = tmp_path / "provider.json"
    monkeypatch.setattr(onboard_module, "azure_deployments", lambda base_url, key: ["gpt-5.4"])
    ensure_provider(path, Script("azure", "acme", KEY, "my-deployment"))
    assert load_provider(path).llm_config["model"] == "my-deployment"


def test_a_model_typed_before_is_the_answer_for_nothing(monkeypatch):
    monkeypatch.setattr(onboard_module, "provider_models", lambda name, key: [])
    ask = Script("")
    assert onboard_module._ask_model(ask, "anthropic", "claude-opus-4-1", SENTINEL) == "claude-opus-4-1"
    assert ask.offered == [["claude-sonnet-4-5 (the default)"]] and ask.typed == [True]
    ask = Script("")
    assert onboard_module._ask_model(ask, "anthropic", "claude-opus-4-1") == "claude-opus-4-1"
    assert ask.offered == [["the model `yian auth anthropic` saved"]]


def test_a_deployment_typed_before_is_the_answer_for_nothing(monkeypatch):
    monkeypatch.setattr(onboard_module, "azure_deployments", lambda base_url, key: ["gpt-5.4"])
    ask = Script("")
    assert onboard_module._ask_deployment(ask, "https://acme.openai.azure.com/openai/v1/", KEY, "mine") == "mine"
    assert ask.offered == [["gpt-5.4"]] and ask.typed == [True]


def test_an_empty_typed_deployment_on_the_terminal_is_never_saved_empty(monkeypatch):
    monkeypatch.setattr(onboard_module, "azure_deployments", lambda base_url, key: ["gpt-5.4", "o3"])
    # Pick "Type my own answer" (3), then type nothing.
    plain_stdin(monkeypatch, "3\n\n")
    url = "https://acme.openai.azure.com/openai/v1/"
    assert onboard_module._ask_deployment(TtyPrompter(), url, KEY, "") == "gpt-5.4"


def test_azure_asks_for_the_name_when_it_cant_list_the_deployments(tmp_path, monkeypatch):
    path = tmp_path / "provider.json"

    def refused(base_url, key):
        raise OnboardError("HTTP 401")

    monkeypatch.setattr(onboard_module, "azure_deployments", refused)
    ask = Script("azure", "acme", KEY, "gpt-5-4-prod")
    ensure_provider(path, ask)
    assert load_provider(path).llm_config["model"] == "gpt-5-4-prod"
    assert ask.seen[-2:] == ["Couldn't list the deployments (HTTP 401); type the name instead.", "Deployment name"]


def test_setting_azure_up_again_defaults_to_the_last_deployment(tmp_path, monkeypatch):
    path = tmp_path / "provider.json"
    monkeypatch.setattr(onboard_module, "azure_deployments", lambda base_url, key: ["gpt-5.4", "o3"])
    ensure_provider(path, Script("azure", "acme", KEY, "2", "2", "", "", "", ""),
                    check_model=answers("Error code: 429", None))
    assert load_provider(path).llm_config["model"] == "o3"


def test_azure_deployments_waits_fifteen_seconds_and_says_why_it_cant_list_them(monkeypatch):
    seen = []

    def listed(base_url, key, *, timeout):
        seen.append((base_url, key, timeout))
        if len(seen) > 1:
            raise ModelListError("HTTP 401", 401)
        return ["gpt-5.4"]

    monkeypatch.setattr("agent_corp.chat.models.azure_deployments", listed)
    assert azure_deployments("https://acme.openai.azure.com/openai/v1/", KEY) == ["gpt-5.4"]
    with pytest.raises(OnboardError, match="^HTTP 401$"):
        azure_deployments("https://acme.openai.azure.com/openai/v1/", KEY)
    assert seen == [("https://acme.openai.azure.com/openai/v1/", KEY, 15)] * 2


def test_a_provider_offers_the_models_it_lists_for_the_key(tmp_path, monkeypatch):
    path = tmp_path / "provider.json"
    seen = []
    monkeypatch.setattr(onboard_module, "provider_models",
                        lambda name, key: seen.append((name, key)) or ["claude-opus-4-1", "claude-sonnet-4-5"])
    ask = Script("anthropic", SENTINEL, "2")
    ensure_provider(path, ask)
    assert json.loads(path.read_text())["llm_config"] == {"provider": "anthropic", "api_key": SENTINEL,
                                                          "model": "claude-opus-4-1"}
    assert seen == [("anthropic", SENTINEL)]
    assert ask.offered[-1] == ["claude-sonnet-4-5 (the default)", "claude-opus-4-1"] and ask.typed[-1] is True
    assert all(SENTINEL not in line for line in ask.seen)


def test_a_provider_without_a_default_offers_its_models_and_takes_a_typed_one(tmp_path, monkeypatch):
    monkeypatch.setattr(onboard_module, "provider_models", lambda name, key: ["gemini-2.5-flash", "gemini-2.5-pro"])
    path = tmp_path / "provider.json"
    ask = Script("google", SENTINEL, "")
    ensure_provider(path, ask)
    assert load_provider(path).llm_config["model"] == "gemini-2.5-flash"
    assert ask.offered[-1] == ["gemini-2.5-flash", "gemini-2.5-pro"] and ask.typed[-1] is True
    assert onboard_module._ask_model(Script("gemini-3-pro"), "google", key=SENTINEL) == "gemini-3-pro"


def test_a_listing_that_fails_falls_back_to_typing_the_model(tmp_path, monkeypatch):
    def refused(name, key):
        raise OnboardError("HTTP 401")

    monkeypatch.setattr(onboard_module, "provider_models", refused)
    path = tmp_path / "provider.json"
    ask = Script("google", SENTINEL, "gemini-2.5-pro")
    ensure_provider(path, ask)
    assert load_provider(path).llm_config["model"] == "gemini-2.5-pro"
    assert ask.seen[-2:] == ["Couldn't list the models (HTTP 401).", "Model name (google has no default model)"]


def test_nothing_is_listed_without_a_key_or_someone_to_ask(tmp_path, monkeypatch):
    def never(name, key):
        raise AssertionError("nothing to list with")

    monkeypatch.setattr(onboard_module, "provider_models", never)
    ensure_provider(tmp_path / "provider.json", Script("anthropic", "", ""))
    assert onboard_module._ask_model(Script("", interactive=False), "anthropic", key=SENTINEL) == "claude-sonnet-4-5"


def test_provider_models_waits_fifteen_seconds_and_says_why_it_cant_list_them(monkeypatch):
    seen, replies = [], [["claude-sonnet-4-5"], None, ModelListError("HTTP 401", 401)]

    def listed(name, key, *, timeout):
        seen.append((name, key, timeout))
        reply = replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply

    monkeypatch.setattr("agent_corp.chat.models.provider_models", listed)
    assert provider_models("anthropic", SENTINEL) == ["claude-sonnet-4-5"]
    assert provider_models("azure", SENTINEL) == []
    with pytest.raises(OnboardError, match="^HTTP 401$"):
        provider_models("anthropic", SENTINEL)
    assert seen == [("anthropic", SENTINEL, 15), ("azure", SENTINEL, 15), ("anthropic", SENTINEL, 15)]


def test_azure_needs_a_key_and_a_usable_endpoint(tmp_path):
    path = tmp_path / "provider.json"
    ask = Script("azure", "http://acme.example.com", "acme", "", KEY, "dep")
    ensure_provider(path, ask)
    assert load_provider(path).llm_config["api_key"] == KEY
    assert ask.seen.count("Azure OpenAI endpoint or resource name") == 2
    assert ask.seen.count("azure API key (not shown)") == 2
    assert "That doesn't work: azure needs a key" in ask.seen


@pytest.mark.parametrize("llm", [{"provider": "azure", "api_key": KEY}, {"provider": "google", "api_key": KEY}])
def test_a_provider_with_no_model_and_no_default_is_refused(tmp_path, llm):
    with pytest.raises(OnboardError, match=f"llm_config.model is missing, and {llm['provider']} has no default model") \
            as info:
        ensure_provider(tmp_path / "provider.json", Script(), stdin=io.StringIO(json.dumps({"llm_config": llm})))
    assert KEY not in str(info.value) and not (tmp_path / "provider.json").exists()


@pytest.mark.parametrize("name", ["google", "ollama"])
def test_a_provider_with_no_key_and_no_model_takes_the_model_yians_login_saved(tmp_path, name):
    path = tmp_path / "provider.json"
    data = {"llm_config": {"provider": name}}
    assert ensure_provider(path, Script(), stdin=io.StringIO(json.dumps(data))) is True
    assert json.loads(path.read_text()) == data


def test_an_endpoint_of_ones_own_with_no_model_is_refused(tmp_path):
    path = tmp_path / "provider.json"
    llm = {"provider": "openai", "base_url": "https://gateway.example.com/v1", "api_key": KEY}
    with pytest.raises(OnboardError, match="^llm_config.model is missing, and an endpoint of your own has no default "
                                           "model$"):
        ensure_provider(path, Script(), stdin=io.StringIO(json.dumps({"llm_config": llm})))
    assert not path.exists()
    path.write_text(json.dumps({"llm_config": llm}))
    path.chmod(0o600)
    with pytest.raises(OnboardError, match="an endpoint of your own has no default model; fix it or remove it"):
        ensure_provider(path, Script(interactive=False))


def test_an_existing_provider_that_cant_be_used_is_asked_again_on_a_terminal(tmp_path):
    path = tmp_path / "provider.json"
    path.write_text(json.dumps({"llm_config": {"provider": "azure", "api_key": KEY}}))
    path.chmod(0o600)
    ask = Script("openai", "", "")
    assert ensure_provider(path, ask) is True
    assert json.loads(path.read_text()) == {"llm_config": {"provider": "openai"}}
    assert ask.seen[0] == (f"{path}: llm_config.model is missing, and azure has no default model;"
                           " set up the model again.")
    assert all(KEY not in line for line in ask.seen)


def test_an_existing_provider_that_cant_be_used_is_an_error_without_a_terminal(tmp_path):
    path = tmp_path / "provider.json"
    text = json.dumps({"llm_config": {"provider": "azure", "api_key": KEY}})
    path.write_text(text)
    path.chmod(0o600)
    with pytest.raises(OnboardError, match="has no default model; fix it or remove it") as info:
        ensure_provider(path, Script(interactive=False))
    assert KEY not in str(info.value) and path.read_text() == text


def test_no_key_means_composers_own_login(tmp_path):
    path = tmp_path / "provider.json"
    ask = Script("openai", "", "")
    ensure_provider(path, ask)
    assert json.loads(path.read_text()) == {"llm_config": {"provider": "openai"}}
    assert any("yian auth" in line for line in ask.seen)
    assert ask.offered[-1] == ["the model `yian auth openai` saved"] and ask.typed[-1] is True


def test_no_key_takes_a_typed_model_too(tmp_path):
    path = tmp_path / "provider.json"
    ensure_provider(path, Script("google", "", "gemini-2.5-pro"))
    assert json.loads(path.read_text()) == {"llm_config": {"provider": "google", "model": "gemini-2.5-pro"}}


def test_a_keyless_provider_without_a_key_offers_its_models(tmp_path, monkeypatch):
    monkeypatch.setattr(onboard_module, "provider_models", lambda name, key: ["llama3", "qwen3"])
    path = tmp_path / "provider.json"
    ask = Script("ollama", "", "")
    ensure_provider(path, ask)
    assert json.loads(path.read_text()) == {"llm_config": {"provider": "ollama", "model": "llama3"}}
    assert ask.offered[-1] == ["llama3", "qwen3"]


def test_a_key_in_the_environment_is_never_read(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", KEY)
    path = tmp_path / "provider.json"
    ensure_provider(path, Script("anthropic", "", ""))
    assert KEY not in path.read_text() and "api_key" not in json.loads(path.read_text())["llm_config"]


def test_an_unknown_provider_preset_gives_up(tmp_path, capsys):
    with pytest.raises(OnboardError, match="no usable answer to 'Model provider'"):
        ensure_provider(tmp_path / "provider.json", TtyPrompter({"Model provider": "antrhopic"}))
    assert f"That doesn't work: choose one of: {', '.join(SUPPORTED_LLM_PROVIDERS)}\n" in capsys.readouterr().out
    assert not (tmp_path / "provider.json").exists()


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
    ({"provider": "ollama", "base_url": "https://gateway.example.com/v1", "api_key": KEY, "model": "llama3"},
     "ollama does not take llm_config.base_url"),
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
        ensure_provider(path, Script(interactive=False))
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
        monkeypatch.delenv("NO_COLOR", raising=False)  # the init flow's environment drops it after this
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


def test_without_a_terminal_a_typed_list_ends_with_typing_your_own(monkeypatch, capsys):
    plain_stdin(monkeypatch, "2\nmy-model\n")
    assert TtyPrompter().choose("Model", ["sonnet (the default)"], "sonnet (the default)", typed=True) == "my-model"
    assert f"  2. {TYPE_OWN}\n" in capsys.readouterr().out


def test_without_a_terminal_a_typed_list_still_picks_an_option(monkeypatch):
    plain_stdin(monkeypatch, "1\n")
    assert TtyPrompter().choose("Model", ["sonnet (the default)"], typed=True) == "sonnet (the default)"


def test_a_typed_default_that_isnt_an_option_is_the_typed_answers_default(monkeypatch):
    plain_stdin(monkeypatch, "\n\n")
    assert TtyPrompter().choose("Model", ["sonnet (the default)"], "my-model", typed=True) == "my-model"


def test_an_empty_typed_answer_on_the_terminal_is_the_default(monkeypatch):
    plain_stdin(monkeypatch, "2\n\n")
    assert TtyPrompter().choose("Deployment", ["gpt-5.4"], "gpt-5.4", typed=True) == "gpt-5.4"


def test_a_typed_list_with_no_one_to_ask_takes_its_default():
    assert TtyPrompter(interactive=False).choose("Model", ["a"], "typed-before", typed=True) == "typed-before"


def test_the_script_prompter_takes_typed_text_only_for_a_typed_list():
    ask = Script("my-model")
    assert ask.choose("Model", ["a"], typed=True) == "my-model"
    assert ask.typed == [True]
    with pytest.raises(AssertionError, match="'my-model' isn't an answer"):
        Script("my-model").choose("Model", ["a"])


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


def a_colour_terminal(monkeypatch):
    """Make stdout and stdin look like a terminal, with colour on."""
    monkeypatch.setattr("sys.stdout.isatty", lambda: True)
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.delenv("NO_COLOR", raising=False)
    monkeypatch.setenv("TERM", "xterm-256color")


def test_on_a_terminal_a_step_is_a_bold_cyan_header_and_a_grey_why(monkeypatch, capsys):
    a_colour_terminal(monkeypatch)
    TtyPrompter().step(2, 5, "You", "You're the CEO.")
    assert capsys.readouterr().out == "\n\x1b[1;36mStep 2 of 5: You\x1b[0m\n\x1b[90mYou're the CEO.\x1b[0m\n"


@pytest.mark.parametrize("name, value", [("NO_COLOR", "1"), ("TERM", "dumb")])
def test_without_colour_a_step_on_a_terminal_is_plain(monkeypatch, capsys, name, value):
    a_colour_terminal(monkeypatch)
    monkeypatch.setenv(name, value)
    prompter = TtyPrompter()
    monkeypatch.delenv(name)  # the init flow's environment drops it after the prompter is made
    prompter.step(2, 5, "You", "You're the CEO.")
    assert capsys.readouterr().out == "\nStep 2 of 5: You\nYou're the CEO.\n"


@pytest.mark.parametrize("no_color, prompt", [(False, "\x1b[1;36m?\x1b[0m anthropic API key: "),
                                              (True, "anthropic API key: ")])
def test_on_a_terminal_a_secret_is_marked_like_the_other_questions(monkeypatch, no_color, prompt):
    a_colour_terminal(monkeypatch)
    if no_color:
        monkeypatch.setenv("NO_COLOR", "1")
    shown = []
    monkeypatch.setattr(getpass, "getpass", lambda text: shown.append(text) or KEY)
    assert TtyPrompter().secret("anthropic API key") == KEY
    assert shown == [prompt]


def test_a_dumb_terminal_gets_a_numbered_list(monkeypatch, capsys):
    a_colour_terminal(monkeypatch)
    monkeypatch.setenv("TERM", "dumb")
    plain_stdin(monkeypatch, "2\n")
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    assert TtyPrompter().choose("Q", ["a", "b"]) == "b"
    assert "  2. b" in capsys.readouterr().out


def test_an_empty_no_color_leaves_colour_on(monkeypatch):
    a_colour_terminal(monkeypatch)
    monkeypatch.setenv("NO_COLOR", "")
    assert TtyPrompter().color is True


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


def answers(*problems):
    """A model check that finds each of ``problems`` in turn (None: the model answered), recording what it checked."""
    checked, left = [], list(problems)

    def check(provider):
        checked.append(provider.llm_config)
        return left.pop(0)

    check.checked = checked
    return check


def test_the_provider_is_saved_only_once_the_model_answers(tmp_path):
    path = tmp_path / "provider.json"
    check = answers(None)
    ask = Script("openai", KEY, "")
    assert ensure_provider(path, ask, check_model=check) is True
    assert check.checked == [{"provider": "openai", "api_key": KEY, "model": "gpt-5.5"}]
    assert ask.seen[-1] == "Checking that the model answers..."
    assert load_provider(path).llm_config == {"provider": "openai", "api_key": KEY, "model": "gpt-5.5"}


def test_trying_again_checks_the_same_answers_and_nothing_is_saved_until_it_works(tmp_path):
    path = tmp_path / "provider.json"

    def check(provider):
        assert not path.exists()
        return problems.pop(0)

    problems = ["Connection error", "Connection error", None]
    ask = Script("openai", KEY, "", "", "1")
    ensure_provider(path, ask, check_model=check)
    assert ask.seen.count("The model didn't answer: Connection error") == 2
    assert ask.offered[-2:] == [[TRY_AGAIN, SET_UP_AGAIN]] * 2
    assert load_provider(path).llm_config == {"provider": "openai", "api_key": KEY, "model": "gpt-5.5"}


def test_setting_up_again_starts_from_the_last_answers_and_keeps_the_key(tmp_path):
    path = tmp_path / "provider.json"
    check = answers("Error code: 404 - DeploymentNotFound", None)
    ask = Script("azure", "acme", KEY, "gpt-5-4", "2", "", "", "", "gpt-5-4-prod")
    ensure_provider(path, ask, check_model=check)
    assert load_provider(path).llm_config == {
        "provider": "openai", "base_url": "https://acme.openai.azure.com/openai/v1/", "api_key": KEY,
        "model": "gpt-5-4-prod"}
    assert "azure API key (empty keeps the one you just typed; not shown)" in ask.seen
    assert all(KEY not in line for line in ask.seen)


def test_picking_the_default_when_setting_up_again_drops_the_typed_model(tmp_path):
    path = tmp_path / "provider.json"
    # Typed, then the default; the third round's empty answers keep the default.
    ask = Script("openai", "", "gpt-x", "2", "", "", "1", "2", "", "", "")
    ensure_provider(path, ask, check_model=answers("Error code: 404", "Error code: 404", None))
    assert load_provider(path).llm_config == {"provider": "openai"}


def test_a_model_that_never_answers_is_never_saved(tmp_path):
    path = tmp_path / "provider.json"
    ask = Script("openai", KEY, "", "1", "1")
    with pytest.raises(IndexError):  # the script ran out: only the owner can stop asking, with Ctrl-C
        ensure_provider(path, ask, check_model=lambda provider: "Connection error")
    assert not path.exists()


def test_without_a_terminal_a_model_that_doesnt_answer_is_an_error(tmp_path):
    path = tmp_path / "provider.json"
    with pytest.raises(OnboardError, match="^the model didn't answer: Connection error$"):
        ensure_provider(path, Script(interactive=False), stdin=io.StringIO(json.dumps(
            {"llm_config": {"provider": "openai", "api_key": KEY}})), check_model=lambda provider: "Connection error")
    assert not path.exists()



def test_a_key_is_never_kept_for_another_provider(tmp_path):
    path = tmp_path / "provider.json"
    check = answers("Error code: 401", None)
    ask = Script("azure", "acme", KEY, "gpt-5-4", "2", "openai", "", "1")
    ensure_provider(path, ask, check_model=check)
    assert load_provider(path).llm_config == {"provider": "openai"}
    assert "openai API key (empty to use `yian auth openai`; not shown)" in ask.seen

import json
import os

import pytest
from starlette.requests import Request

from agent_corp.chat.provider import Price, Provider, ProviderError, load_provider
from agent_corp.store import Store
from agent_corp.testing.fake_llm import LLM_CONFIG, FakeLLM
from agent_corp.worker.job import Job, SessionMemorySpec, group_specs
from agent_corp.worker.spawn import WorkerRegistry
from tests.worker.conftest import Recorder, agent_flow, run, write_files

SENTINEL = "sk-sentinel-4b1d9e"


def write(path, data, mode=0o600):
    path.write_text(data if isinstance(data, str) else json.dumps(data))
    os.chmod(path, mode)
    return path


def test_no_file_means_composer_defaults(tmp_path):
    assert load_provider(tmp_path / "provider.json") == Provider()


def test_reads_config_env_and_prices(tmp_path):
    path = write(tmp_path / "provider.json", {
        "llm_config": {"provider": "anthropic", "model": "claude-x", "api_key": SENTINEL},
        "env": {"ANTHROPIC_BASE_URL": "https://llm.example"},
        "prices": {"claude-x": {"input": 3, "output": 15}},
    })
    provider = load_provider(path)
    assert provider.llm_config == {"provider": "anthropic", "model": "claude-x", "api_key": SENTINEL}
    assert provider.env == {"ANTHROPIC_BASE_URL": "https://llm.example"}
    assert provider.prices == {"claude-x": Price(input=3, output=15)}
    assert SENTINEL not in repr(provider)


@pytest.mark.parametrize("name", ["ANTHROPIC_API_KEY", "GH_TOKEN", "CLIENT_SECRET", "DB_PASSWORD",
                                  "PASSWORD_FILE", "openai_api_key", "OPENAI_APIKEY", "DB_PASS",
                                  "GOOGLE_APPLICATION_CREDENTIALS", "AWS_CREDENTIALS"])
def test_a_credential_in_env_is_refused(tmp_path, name):
    path = write(tmp_path / "provider.json", {"env": {name: SENTINEL}})
    with pytest.raises(ProviderError, match=r"llm_config\.api_key") as info:
        load_provider(path)
    assert SENTINEL not in str(info.value)


@pytest.mark.parametrize("url", [f"https://user:{SENTINEL}@proxy.example:3128", f"http://{SENTINEL}@llm.example",
                                 f"socks5://u:{SENTINEL}@h", f"  https://u:{SENTINEL}@h", f"\thttp://{SENTINEL}@h"])
def test_a_url_with_credentials_in_env_is_refused(tmp_path, url):
    path = write(tmp_path / "provider.json", {"env": {"HTTPS_PROXY": url}})
    with pytest.raises(ProviderError, match="HTTPS_PROXY") as info:
        load_provider(path)
    assert SENTINEL not in str(info.value)


@pytest.mark.parametrize("value", ["https://proxy.example:3128", "http://llm.example/v1?user=a@b", "/etc/ssl/ca.pem",
                                   "a@b.example"])
def test_settings_that_arent_credentials_are_kept(tmp_path, value):
    path = write(tmp_path / "provider.json", {"env": {"HTTPS_PROXY": value}})
    assert load_provider(path).env == {"HTTPS_PROXY": value}


@pytest.mark.parametrize("env", [{f"{SENTINEL}_KEY": "v"}, {SENTINEL: 5}, {SENTINEL: "https://u:p@h"}])
def test_an_env_name_that_isnt_a_variable_name_is_never_echoed(tmp_path, env):
    path = write(tmp_path / "provider.json", {"env": env})
    with pytest.raises(ProviderError) as info:
        load_provider(path)
    assert SENTINEL not in str(info.value)


@pytest.mark.parametrize("data", [{SENTINEL: "v"}, {"api_key": SENTINEL},
                                  {"prices": {"m": {"input": 1, "output": 1, SENTINEL: 1}}}])
def test_an_extra_field_is_never_named(tmp_path, data):
    path = write(tmp_path / "provider.json", data)
    with pytest.raises(ProviderError, match="an extra field") as info:
        load_provider(path)
    assert SENTINEL not in str(info.value) and "api_key" not in str(info.value)


@pytest.mark.parametrize("prices", [{SENTINEL: {"input": "x", "output": 1}}, {SENTINEL: {"input": -1, "output": 1}},
                                    {SENTINEL: 5}])
def test_a_model_name_in_prices_is_never_echoed(tmp_path, prices):
    path = write(tmp_path / "provider.json", {"prices": prices})
    with pytest.raises(ProviderError, match="prices") as info:
        load_provider(path)
    assert SENTINEL not in str(info.value)


def test_a_file_others_can_read_is_refused(tmp_path):
    path = write(tmp_path / "provider.json", {}, mode=0o644)
    with pytest.raises(ProviderError, match="mode 0600"):
        load_provider(path)


def test_a_symlink_is_refused(tmp_path):
    target = write(tmp_path / "real.json", {})
    (tmp_path / "provider.json").symlink_to(target)
    with pytest.raises(ProviderError, match="can't open"):
        load_provider(tmp_path / "provider.json")


@pytest.mark.parametrize("text", ['{"env": {"KEY": 12345678}, "llm_config": "sk-secret-value"}', "sk-secret-value"])
def test_errors_never_echo_the_file(tmp_path, text):
    path = write(tmp_path / "provider.json", text)
    with pytest.raises(ProviderError) as info:
        load_provider(path)
    assert "sk-secret-value" not in str(info.value) and "12345678" not in str(info.value)


def echo(text: str) -> str:
    """Return ``text``."""
    return text


class KeyedLLM(FakeLLM):
    """A fake LLM that also records each request's bearer token."""

    def __init__(self) -> None:
        super().__init__()
        self.tokens: list[str] = []

    async def _completions(self, request: Request):
        self.tokens.append(request.headers.get("authorization", ""))
        return await super()._completions(request)


def test_a_key_in_llm_config_reaches_the_model_and_nothing_else(tmp_path):
    """The key travels only in the start frame: not in the run log, the session dir, the store, or a frame."""
    flow = agent_flow("keyed", top="long_term_memory: session\n",
                      node="    mode: tool_calling\n    tools: [toolbox]\n")
    pin = write_files(tmp_path / "pin", {"flows/keyed.yaml": flow})
    session_dir, log = tmp_path / "sessions" / "s1", tmp_path / "sessions" / "s1" / "runs" / "r1.jsonl"
    tools = {"toolbox": {"echo": echo}}
    with KeyedLLM() as fake, Store(tmp_path / "office" / "store.sqlite") as store:
        fake.script({"tool_calls": [{"name": "echo", "arguments": {"text": "ping"}}]}, {"content": "done"})
        job = Job(kind="chat", session_id="s1", run_id="r1", person_id="minh", pin=str(pin),
                  flow="flows/keyed.yaml", log=str(log), inputs={"message": "hi"},
                  llm_config={**LLM_CONFIG, "api_key": SENTINEL}, groups=group_specs(tools),
                  memory={"session": SessionMemorySpec(storage=str(session_dir / "memory.sqlite"))},
                  env=fake.env())
        registry = WorkerRegistry(store)
        try:
            handlers = run(registry, job, Recorder(tools=tools), session_dir)
        finally:
            registry.close_all(timeout=5)
        requests = fake.requests()
    frames = [*handlers.frames, handlers.outcome or {"type": "no outcome"}]
    leaks = {("frame", f["type"], f.get("name")) for f in frames if SENTINEL in json.dumps(f, default=str)}
    leaks |= {("model request",) for r in requests if SENTINEL in json.dumps(r)}
    leaks |= {("file", str(p.relative_to(tmp_path))) for root in (session_dir, tmp_path / "office")
              for p in root.rglob("*") if p.is_file() and SENTINEL.encode() in p.read_bytes()}
    assert sorted(leaks, key=str) == []
    assert handlers.outcome["status"] == "succeeded" and handlers.returncode == 0
    assert fake.tokens and all(token == f"Bearer {SENTINEL}" for token in fake.tokens)
    assert "ToolCallFinished" in json.dumps(handlers.frames)
    assert log.exists() and (session_dir / "worker.log").exists()

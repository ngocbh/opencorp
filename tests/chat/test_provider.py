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
                                  "PASSWORD_FILE", "openai_api_key"])
def test_a_credential_in_env_is_refused(tmp_path, name):
    path = write(tmp_path / "provider.json", {"env": {name: SENTINEL}})
    with pytest.raises(ProviderError, match=r"llm_config\.api_key") as info:
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


# Composer 770800e's LLMConfig is extra="forbid" with no api_key field: the run fails, and the
# pydantic error echoes the key into NodeFailed, RunFailed, the result frame, and the run log.
# This passes once composer takes a secret api_key in llm_config; then drop the marker.
@pytest.mark.xfail(strict=True, raises=AssertionError, reason="composer's LLMConfig refuses api_key")
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
        assert handlers.outcome["status"] == "succeeded" and handlers.returncode == 0
        assert fake.tokens and all(token == f"Bearer {SENTINEL}" for token in fake.tokens)
        frames = json.dumps([*handlers.frames, handlers.outcome])
        assert "ToolCallFinished" in frames and SENTINEL not in frames
        assert SENTINEL not in json.dumps(fake.requests())
    assert log.exists() and (session_dir / "worker.log").exists()
    written = [p for root in (session_dir, tmp_path / "office") for p in root.rglob("*") if p.is_file()]
    assert [p for p in written if SENTINEL.encode() in p.read_bytes()] == []

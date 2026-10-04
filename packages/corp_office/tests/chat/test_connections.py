import hashlib
import json
import os
import stat
from pathlib import Path

import pytest
from pydantic import ValidationError

from agent_corp.chat.connections import (
    OFFICE,
    ConnectionFile,
    ConnectionGone,
    Connections,
    RunMoved,
    RunRecord,
    azure_base_url,
    config_hash,
    key_id,
    provider_label,
    read_run_record,
    recorded_base_urls,
    target_hash,
    write_run_record,
)
from agent_corp.chat.provider import Price, Provider, ProviderError
from agent_corp.protocol.models import Connection
from agent_corp.secrets import write_private

SENTINEL = "sk-ant-sentinel-a7d93c10e5b2"
OTHER_KEY = "sk-ant-other-5f0e2b7c91d4"
BASE = "https://office.example/v1/"


def office_dir(tmp_path, provider=None):
    """An office directory, with ``provider`` as its provider.json when given."""
    office = tmp_path / "office"
    office.mkdir(mode=0o700)
    if provider is not None:
        write_private(office / "provider.json", json.dumps(provider).encode())
    return office


def api_key(model="gpt-4o", key=SENTINEL, base_url="https://second.example/v1/", **extra):
    return ConnectionFile(llm_config={"provider": "openai", "base_url": base_url, "api_key": key, "model": model},
                          **extra)


def subscription(model="gpt-5.5"):
    return ConnectionFile(method="subscription", llm_config={"provider": "openai", "model": model})


def mode(path):
    return stat.S_IMODE(os.stat(path).st_mode)


def tree(root):
    return sorted(str(p.relative_to(root)) for p in root.rglob("*"))


def run_started_log(path, *base_urls):
    """A run log whose first line is a run_started record with one agent per base URL (None: no base_url)."""
    agents = {}
    for i, url in enumerate(base_urls):
        agents[f"agent{i}"] = {"provider": "openai", "model": "m"} | ({"base_url": url} if url else {})
    first = {"kind": "run_started", "payload": {"effective_llm_by_static_path": agents, "num_workers": 0},
             "run_id": path.stem, "schema": 9, "seq": 0}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(first, sort_keys=True, separators=(",", ":")) + "\n"
                    + '{"kind":"node_started","payload":{"node_id":"__start__"},"seq":1}\n')
    return path


def test_provider_json_is_the_office_connection_and_the_default(tmp_path):
    c = Connections(office_dir(tmp_path, {"llm_config": {"provider": "anthropic", "model": "claude-x",
                                                         "api_key": SENTINEL}}))
    assert c.names() == [OFFICE]
    assert c.default() == OFFICE
    assert c.get(OFFICE).llm_config["api_key"] == SENTINEL
    info = c.info(OFFICE)
    assert info == Connection(name=OFFICE, provider="anthropic", method="api_key", model="claude-x", default=True)
    assert SENTINEL not in repr(info) and SENTINEL not in info.model_dump_json()


def test_no_provider_json_is_an_office_connection_on_composer_defaults(tmp_path):
    c = Connections(office_dir(tmp_path))
    assert c.names() == [OFFICE]
    assert c.info(OFFICE) == Connection(name=OFFICE, provider="composer", method="none", model=None, default=True)
    assert c.resolve(None, None) == Provider()


def test_put_writes_0600_in_a_0700_dir_and_never_shows_the_key(tmp_path, caplog):
    office = office_dir(tmp_path)
    c = Connections(office)
    old = os.umask(0o022)
    try:
        c.put("azure", api_key(base_url=azure_base_url("acme")))
    finally:
        os.umask(old)
    assert mode(office / "connections") == 0o700
    assert mode(office / "connections" / "azure.json") == 0o600
    assert c.names() == [OFFICE, "azure"]
    assert c.get("azure").llm_config["api_key"] == SENTINEL
    info = c.info("azure")
    assert info == Connection(name="azure", provider="azure", method="api_key", model="gpt-4o", default=False)
    assert SENTINEL not in repr(info) and SENTINEL not in info.model_dump_json()
    assert SENTINEL not in repr(c.get("azure")) and SENTINEL not in repr(c.resolve("azure", None))
    assert SENTINEL not in caplog.text


def test_a_group_readable_connection_is_refused(tmp_path):
    office = office_dir(tmp_path)
    c = Connections(office)
    c.put("second", api_key())
    path = office / "connections" / "second.json"
    path.chmod(0o640)
    with pytest.raises(ProviderError, match=str(path)) as info:
        c.resolve("second", None)
    assert SENTINEL not in str(info.value)


@pytest.mark.parametrize("bad", ["Office", "..", "../x", "a/b", "_default", "_removed", "chatgpt.auth", "",
                                 "office", "default", "login"])
def test_bad_or_reserved_names_raise_before_any_path(tmp_path, bad):
    c = Connections(office_dir(tmp_path, {"llm_config": {"provider": "anthropic", "api_key": SENTINEL}}))
    before = tree(tmp_path)
    calls = [lambda: c.put(bad, api_key()), lambda: c.remove(bad), lambda: c.auth_file(bad)]
    if bad != OFFICE:
        calls += [lambda: c.get(bad), lambda: c.info(bad), lambda: c.resolve(bad, None), lambda: c.set_default(bad)]
    for call in calls:
        with pytest.raises(ValueError):
            call()
    if bad == OFFICE:  # office can be read and resolved, never written or removed
        assert c.get(bad).llm_config["provider"] == "anthropic"
        assert c.resolve(bad, None) == c.resolve(None, None)
    assert tree(tmp_path) == before


def test_default_follows_the_pointer_and_falls_back_when_its_file_is_gone(tmp_path):
    office = office_dir(tmp_path)
    c = Connections(office)
    c.put("second", api_key())
    c.set_default("second")
    assert c.default() == "second"
    assert mode(office / "connections" / "_default.json") == 0o600
    assert c.info("second").default and not c.info(OFFICE).default
    assert Connections(office).default() == "second"
    (office / "connections" / "second.json").unlink()
    assert c.default() == OFFICE
    with pytest.raises(ConnectionGone):
        c.set_default("nope")
    c.set_default(OFFICE)
    assert c.default() == OFFICE


def test_remove_unlinks_the_connection_and_its_sign_in(tmp_path, monkeypatch):
    office = office_dir(tmp_path)
    c = Connections(office)
    c.put("chatgpt", subscription())
    write_private(c.auth_file("chatgpt"), b"{}")
    removed_at_unlink = []
    unlink = Path.unlink

    def spy(self, missing_ok=False):
        if not self.name.startswith("."):  # write_private clears its own temp file first
            removed_at_unlink.append(json.loads((office / "connections" / "_removed.json").read_text()))
        unlink(self, missing_ok=missing_ok)

    monkeypatch.setattr(Path, "unlink", spy)
    c.remove("chatgpt")
    monkeypatch.undo()
    assert removed_at_unlink and all(r == {"names": ["chatgpt"]} for r in removed_at_unlink)
    assert not (office / "connections" / "chatgpt.json").exists()
    assert not c.auth_file("chatgpt").exists()
    assert c.names() == [OFFICE]
    with pytest.raises(ConnectionGone, match="removed"):
        c.get("chatgpt")
    with pytest.raises(ConnectionGone):
        c.remove("chatgpt")


def test_office_cannot_be_removed(tmp_path):
    office = office_dir(tmp_path, {"llm_config": {"provider": "anthropic", "api_key": SENTINEL}})
    c = Connections(office)
    with pytest.raises(ValueError, match="ac onboard"):
        c.remove(OFFICE)
    assert (office / "provider.json").exists()


def test_free_name_skips_names_with_either_file(tmp_path):
    c = Connections(office_dir(tmp_path))
    assert c.free_name("azure") == "azure"
    c.put("azure", api_key())
    c.put("azure-2", api_key())
    assert c.free_name("azure") == "azure-3"
    c.ensure_dir()
    write_private(c.auth_file("chatgpt"), b"{}")  # a sign-in whose connection was never written
    assert c.free_name("chatgpt") == "chatgpt-2"


def test_a_removed_name_is_never_reused(tmp_path):
    office = office_dir(tmp_path)
    c = Connections(office)
    c.put("anthropic", ConnectionFile(llm_config={"provider": "anthropic", "api_key": SENTINEL}))
    c.remove("anthropic")
    assert c.free_name("anthropic") == "anthropic-2"
    assert Connections(office).free_name("anthropic") == "anthropic-2"
    with pytest.raises(ValueError, match="removed"):
        c.put("anthropic", ConnectionFile(llm_config={"provider": "anthropic", "api_key": SENTINEL}))
    assert c.names() == [OFFICE]


def test_a_removed_name_is_gone_even_if_its_file_was_left(tmp_path):
    office = office_dir(tmp_path)
    c = Connections(office)
    c.put("second", api_key())
    write_private(office / "connections" / "_removed.json", b'{"names": ["second"]}')  # a remove cut short
    assert c.names() == [OFFICE]
    with pytest.raises(ConnectionGone):
        c.resolve("second", None)


def test_a_garbled_removed_list_is_refused_not_ignored(tmp_path):
    office = office_dir(tmp_path)
    c = Connections(office)
    c.ensure_dir()
    for garbled in (b"{", b'{"names": "anthropic"}', b'{"names": [1]}'):
        write_private(office / "connections" / "_removed.json", garbled)
        with pytest.raises(ProviderError, match="_removed.json"):
            c.free_name("anthropic")


def test_resolve_puts_the_model_in_llm_config(tmp_path):
    c = Connections(office_dir(tmp_path, {"llm_config": {"provider": "vllm", "model": "a"},
                                          "env": {"VLLM_BASE_URL": "http://x"}}))
    assert c.resolve("office", "b").llm_config == {"provider": "vllm", "model": "b"}
    assert c.resolve("office", "b").env == {"VLLM_BASE_URL": "http://x"}
    assert c.resolve("office", None).llm_config["model"] == "a"
    c.put("second", api_key())
    c.set_default("second")
    assert c.resolve(None, None) == c.resolve("office", None)  # null is office, not the default


def test_a_subscription_resolves_to_its_own_auth_file_and_no_key(tmp_path):
    c = Connections(office_dir(tmp_path))
    c.put("chatgpt", subscription())
    write_private(c.auth_file("chatgpt"), b"{}")
    p = c.resolve("chatgpt", "gpt-5.4")
    assert p.llm_config == {"provider": "openai", "model": "gpt-5.4"}
    assert p.env == {"AGENT_COMPOSER_AUTH_FILE": str(tmp_path / "office" / "connections" / "chatgpt.auth.json")}
    assert c.resolve("chatgpt", None).llm_config == {"provider": "openai", "model": "gpt-5.5"}
    assert c.info("chatgpt") == Connection(name="chatgpt", provider="chatgpt", method="subscription",
                                           model="gpt-5.5", default=False)
    with pytest.raises(ValidationError):  # a key would take the run off the subscription
        ConnectionFile(method="subscription", llm_config={"provider": "openai", "model": "m", "api_key": SENTINEL})
    with pytest.raises(ValidationError):
        ConnectionFile(method="subscription", llm_config={"provider": "anthropic", "model": "m"})


def test_a_subscription_without_its_sign_in_fails_clearly(tmp_path):
    c = Connections(office_dir(tmp_path))
    c.put("chatgpt", subscription())
    with pytest.raises(ProviderError, match="connection 'chatgpt' has no sign-in"):
        c.resolve("chatgpt", None)


def test_resolving_a_removed_connection_raises_connection_gone(tmp_path):
    c = Connections(office_dir(tmp_path))
    c.put("second", api_key())
    c.remove("second")
    with pytest.raises(ConnectionGone, match="second"):
        c.resolve("second", None)
    with pytest.raises(ConnectionGone, match="nope"):
        c.resolve("nope", None)


def test_prices_are_per_connection(tmp_path):
    c = Connections(office_dir(tmp_path, {"llm_config": {"provider": "anthropic", "api_key": SENTINEL},
                                          "prices": {"claude-x": {"input": 3, "output": 15}}}))
    c.put("second", api_key(prices={"gpt-4o": Price(input=1, output=2)}))
    assert c.resolve("second", None).prices == {"gpt-4o": Price(input=1, output=2)}
    assert c.resolve(OFFICE, None).prices == {"claude-x": Price(input=3, output=15)}


def test_labels():
    assert provider_label({"provider": "openai", "base_url": azure_base_url("acme")}) == "azure"
    assert provider_label({"provider": "openai", "base_url": "https://acme.cognitiveservices.azure.com/openai/v1/"}) \
        == "azure"
    assert provider_label({"provider": "openai", "base_url": "https://gw.example/v1/"}) == "custom"
    assert provider_label({"provider": "openai"}) == "openai"
    assert provider_label({"provider": "anthropic", "api_key": SENTINEL}) == "anthropic"
    assert provider_label({"model": "m"}) == provider_label(None) == "composer"


def test_azure_base_url():
    assert azure_base_url("acme") == "https://acme.openai.azure.com/openai/v1/"
    assert azure_base_url(" https://acme.example.com/openai/v1/ ") == "https://acme.example.com/openai/v1/"


# run records

def test_a_run_record_holds_hashes_and_no_key(tmp_path, caplog):
    c = Connections(office_dir(tmp_path))
    c.put("second", api_key())
    provider = c.resolve("second", "gpt-4o-mini")
    path = tmp_path / "runs" / "r1.model.json"
    write_run_record(path, "second", "gpt-4o-mini", provider)
    assert SENTINEL not in path.read_text()
    assert mode(path) == 0o600
    record = read_run_record(path)
    assert (record.connection, record.model) == ("second", "gpt-4o-mini")
    assert len(record.config) == len(record.target) == 64 and record.config != record.target
    assert key_id(provider) == hashlib.sha256(SENTINEL.encode()).hexdigest()
    assert key_id(Provider()) is None
    assert SENTINEL not in caplog.text


def test_write_run_record_creates_runs_dir(tmp_path):
    path = tmp_path / "session" / "runs" / "r1.model.json"
    write_run_record(path, OFFICE, None, Provider())
    assert read_run_record(path) == RunRecord(OFFICE, None, config_hash(Provider()), target_hash(Provider()))
    assert read_run_record(tmp_path / "session" / "runs" / "none.model.json") is None
    path.write_text("{")
    with pytest.raises(ValueError):
        read_run_record(path)


def _record(c, tmp_path, name="second", model=None):
    path = tmp_path / "runs" / "r1.model.json"
    write_run_record(path, name, model, c.resolve(name, model))
    return read_run_record(path), tmp_path / "runs" / "r1.jsonl"


def test_for_run_exact_needs_the_whole_config(tmp_path):
    c = Connections(office_dir(tmp_path))
    c.put("second", api_key())
    record, log = _record(c, tmp_path)
    assert c.for_run(record, log, exact=True) == c.resolve("second", None)
    c.put("second", api_key(model="gpt-4o-mini"))
    with pytest.raises(RunMoved, match="connection 'second' changed since run r1"):
        c.for_run(record, log, exact=True)
    assert c.for_run(record, log, exact=False).llm_config["model"] == "gpt-4o-mini"


def test_for_run_fails_on_a_changed_key_or_endpoint(tmp_path):
    c = Connections(office_dir(tmp_path))
    c.put("second", api_key())
    record, log = _record(c, tmp_path)
    c.put("second", api_key(key=OTHER_KEY))
    for exact in (True, False):
        with pytest.raises(RunMoved, match="connection 'second' changed") as info:
            c.for_run(record, log, exact=exact)
        assert SENTINEL not in str(info.value) and OTHER_KEY not in str(info.value)
    c.put("second", api_key(base_url="https://elsewhere.example/v1/"))
    with pytest.raises(RunMoved, match=r"connection 'second' changed \(endpoint or key\) since run r1"):
        c.for_run(record, log, exact=False)


def test_for_run_fails_on_a_removed_connection(tmp_path):
    c = Connections(office_dir(tmp_path))
    c.put("second", api_key())
    record, log = _record(c, tmp_path)
    c.remove("second")
    for exact in (True, False):
        with pytest.raises(RunMoved, match="connection 'second' was removed"):
            c.for_run(record, log, exact=exact)


def test_a_run_without_a_record_is_office_only_on_the_same_base_url(tmp_path):
    c = Connections(office_dir(tmp_path, {"llm_config": {"provider": "openai", "base_url": BASE,
                                                         "api_key": SENTINEL, "model": "m"}}))
    log = run_started_log(tmp_path / "runs" / "r1.jsonl", BASE, BASE)
    assert recorded_base_urls(log) == {BASE}
    for exact in (True, False):
        assert c.for_run(None, log, exact=exact) == c.resolve(OFFICE, None)
    run_started_log(log, BASE, "https://elsewhere.example/v1/")
    with pytest.raises(RunMoved, match="run r1 has no record and ran on another endpoint"):
        c.for_run(None, log, exact=True)
    run_started_log(log, None)
    with pytest.raises(RunMoved):
        c.for_run(None, log, exact=True)
    log.write_text("{not json\n")
    assert recorded_base_urls(log) is None
    with pytest.raises(RunMoved, match="run r1 has no record"):
        c.for_run(None, log, exact=False)
    log.write_text('{"kind":"node_started","payload":{}}\n')
    assert recorded_base_urls(log) is None
    log.unlink()
    assert recorded_base_urls(log) is None
    with pytest.raises(RunMoved, match="run r1 has no record"):
        c.for_run(None, log, exact=True)


def test_a_run_without_a_record_and_no_base_url_matches_an_office_without_one(tmp_path):
    c = Connections(office_dir(tmp_path, {"llm_config": {"provider": "anthropic", "api_key": SENTINEL}}))
    log = run_started_log(tmp_path / "runs" / "r1.jsonl", None)
    assert recorded_base_urls(log) == {None}
    assert c.for_run(None, log, exact=True) == c.resolve(OFFICE, None)

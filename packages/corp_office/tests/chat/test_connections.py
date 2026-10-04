import fcntl
import hashlib
import json
import os
import stat
import threading
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
    office_endpoint,
    recorded_endpoints,
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


def openai(base_url=None, **extra):
    """A model config as composer pins it in a run log: provider openai, ``base_url`` when given."""
    return {"provider": "openai", "model": "m"} | ({"base_url": base_url} if base_url else {}) | extra


def run_started_log(path, *configs):
    """A run log whose first line is a run_started record with one agent per model config."""
    agents = {f"agent{i}": config for i, config in enumerate(configs)}
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
    lock = c.dir / "chatgpt.auth.json.lock"
    write_private(lock, b"")  # composer's lock on the sign-in
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
    assert not lock.exists()
    assert c.names() == [OFFICE]
    with pytest.raises(ConnectionGone, match="removed"):
        c.get("chatgpt")
    with pytest.raises(ConnectionGone):
        c.remove("chatgpt")


def test_remove_waits_for_composer_to_let_go_of_the_sign_in(tmp_path):
    c = Connections(office_dir(tmp_path))
    c.put("chatgpt", subscription())
    auth = c.auth_file("chatgpt")
    write_private(auth, b"{}")
    lock = c.dir / "chatgpt.auth.json.lock"
    fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)  # composer refreshing the sign-in
    done = threading.Event()
    t = threading.Thread(target=lambda: (c.remove("chatgpt"), done.set()))
    t.start()
    assert not done.wait(0.4)
    assert auth.exists() and lock.exists()
    fcntl.flock(fd, fcntl.LOCK_UN)
    os.close(fd)
    t.join(5)
    assert done.is_set() and not auth.exists() and not lock.exists()


def test_remove_gives_up_on_a_sign_in_locked_too_long(tmp_path, monkeypatch):
    import agent_corp.chat.connections as connections

    monkeypatch.setattr(connections, "SIGN_IN_LOCK_TIMEOUT", 0.2)
    c = Connections(office_dir(tmp_path))
    c.put("chatgpt", subscription())
    write_private(c.auth_file("chatgpt"), b"{}")
    fd = os.open(c.dir / "chatgpt.auth.json.lock", os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    try:
        with pytest.raises(ProviderError, match="timed out"):
            c.remove("chatgpt")
    finally:
        os.close(fd)
    assert c.auth_file("chatgpt").exists()
    assert c.names() == [OFFICE]  # still removed: its name was retired first
    c.remove("chatgpt")
    assert tree(c.dir) == ["_removed.json"]


def test_remove_refuses_a_symlinked_lock(tmp_path):
    c = Connections(office_dir(tmp_path))
    c.put("chatgpt", subscription())
    write_private(c.auth_file("chatgpt"), b"{}")
    target = tmp_path / "elsewhere"
    target.write_text("")
    (c.dir / "chatgpt.auth.json.lock").symlink_to(target)
    with pytest.raises(ProviderError, match="can't open"):
        c.remove("chatgpt")
    assert target.exists()


def test_remove_cleans_a_sign_in_whose_connection_was_never_written(tmp_path):
    c = Connections(office_dir(tmp_path))
    c.ensure_dir()
    write_private(c.auth_file("chatgpt"), b"{}")
    c.remove("chatgpt")
    assert tree(c.dir) == ["_removed.json"]
    with pytest.raises(ConnectionGone):
        c.remove("chatgpt")
    with pytest.raises(ValueError):
        c.remove("../x")


def test_get_reads_a_connection_removed_mid_read_as_gone(tmp_path, monkeypatch):
    import agent_corp.chat.connections as connections

    c = Connections(office_dir(tmp_path))
    c.put("second", api_key())
    load = connections.load_provider

    def removed_first(path, *args, **kwargs):
        path.unlink()  # a remove landing between the removed-list check and the read
        return load(path, *args, **kwargs)

    monkeypatch.setattr(connections, "load_provider", removed_first)
    with pytest.raises(ConnectionGone, match="no connection 'second'"):
        c.get("second")


def test_ensure_dir_fixes_a_loose_directory(tmp_path):
    office = office_dir(tmp_path)
    (office / "connections").mkdir(mode=0o755)
    (office / "connections").chmod(0o755)
    Connections(office).ensure_dir()
    assert mode(office / "connections") == 0o700


@pytest.mark.parametrize("name", ["_removed.json", "_default.json"])
def test_a_symlinked_or_loose_list_is_refused(tmp_path, name):
    office = office_dir(tmp_path)
    c = Connections(office)
    c.put("second", api_key())
    body = b'{"names": ["second"]}' if name == "_removed.json" else b'{"name": "second"}'
    real = tmp_path / "real.json"
    write_private(real, body)
    (c.dir / name).symlink_to(real)
    with pytest.raises(ProviderError, match="can't open"):
        c.names() if name == "_removed.json" else c.default()
    (c.dir / name).unlink()
    write_private(c.dir / name, body)
    (c.dir / name).chmod(0o640)
    with pytest.raises(ProviderError, match="private"):
        c.names() if name == "_removed.json" else c.default()


def test_a_garbled_default_is_refused_not_ignored(tmp_path):
    c = Connections(office_dir(tmp_path))
    c.ensure_dir()
    for garbled in (b"{", b'{"name": 1}', b"[]"):
        write_private(c.dir / "_default.json", garbled)
        with pytest.raises(ProviderError, match="_default.json"):
            c.default()


def test_a_connection_cannot_set_the_auth_file(tmp_path):
    with pytest.raises(ValidationError, match="AGENT_COMPOSER_AUTH_FILE"):
        ConnectionFile(method="subscription", llm_config={"provider": "openai"},
                       env={"AGENT_COMPOSER_AUTH_FILE": str(tmp_path / "other.auth.json")})


def test_infos_lists_every_readable_connection_and_logs_only_a_broken_ones_name(tmp_path, caplog):
    office = office_dir(tmp_path, {"llm_config": {"provider": "anthropic", "api_key": SENTINEL}})
    c = Connections(office)
    c.put("second", api_key())
    c.put("broken", api_key())
    write_private(c.dir / "broken.json", json.dumps({"llm_config": {"api_key": SENTINEL}, "bogus": SENTINEL}).encode())
    write_private(c.dir / "loose.json", api_key().model_dump_json().encode())
    (c.dir / "loose.json").chmod(0o644)
    c.set_default("second")
    infos, default = c.infos()
    assert default == "second"
    assert [(i.name, i.default) for i in infos] == [(OFFICE, False), ("second", True)]
    assert "broken" in caplog.text and "loose" in caplog.text and SENTINEL not in caplog.text
    assert SENTINEL not in repr(infos)


def test_office_cannot_be_removed(tmp_path):
    office = office_dir(tmp_path, {"llm_config": {"provider": "anthropic", "api_key": SENTINEL}})
    c = Connections(office)
    with pytest.raises(ValueError, match="ac onboard"):
        c.remove(OFFICE)
    assert (office / "provider.json").exists()


def test_add_takes_the_first_name_no_file_holds(tmp_path):
    c = Connections(office_dir(tmp_path))
    assert c.add("azure", api_key()) == "azure"
    c.put("azure-2", api_key())
    assert c.add("azure", api_key()) == "azure-3"
    assert c.names()[:4] == [OFFICE, "azure", "azure-2", "azure-3"]
    c.ensure_dir()
    write_private(c.auth_file("chatgpt"), b"{}")  # a sign-in whose connection was never written
    assert c.add("chatgpt", subscription()) == "chatgpt-2"
    assert c.add("login", api_key()) == "login-2"  # a reserved name is skipped like a taken one
    for bad in ("Bad", "x" * 33):
        with pytest.raises(ValueError):
            c.add(bad, api_key())
    assert c.add("x" * 31, api_key()) == "x" * 31
    with pytest.raises(ValueError):  # x*31-2 is too long a name
        c.add("x" * 31, api_key())


def test_add_saves_the_sign_in_before_the_connection(tmp_path):
    c = Connections(office_dir(tmp_path))
    seen = []

    def sign_in(path):
        seen.append((path, sorted(p.name for p in c.dir.iterdir())))
        write_private(path, b"{}")

    name = c.add("chatgpt", subscription(), sign_in=sign_in)
    assert name == "chatgpt" and seen == [(c.auth_file("chatgpt"), [])]
    assert mode(c.dir) == 0o700
    assert c.resolve("chatgpt", None).env["AGENT_COMPOSER_AUTH_FILE"] == str(c.auth_file("chatgpt"))


def test_add_removes_the_sign_in_when_the_connection_cannot_be_written(tmp_path, monkeypatch):
    c = Connections(office_dir(tmp_path))
    import agent_corp.chat.connections as connections

    def fail(path, data):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(connections, "write_private", fail)
    with pytest.raises(OSError):
        c.add("chatgpt", subscription(), sign_in=lambda path: path.write_bytes(b"{}"))
    monkeypatch.undo()
    assert tree(c.dir) == []

    def refuse(path):
        path.write_bytes(b"{}")
        raise ProviderError("sign-in cancelled")

    with pytest.raises(ProviderError, match="cancelled"):
        c.add("chatgpt", subscription(), sign_in=refuse)
    assert tree(c.dir) == []


def test_concurrent_adds_take_distinct_names_and_defaults_stay_whole(tmp_path):
    c = Connections(office_dir(tmp_path))
    c.put("second", api_key())
    errors, names = [], []
    barrier = threading.Barrier(8)

    def add():
        barrier.wait()
        names.append(c.add("azure", api_key()))

    def flip(name):
        barrier.wait()
        try:
            for _ in range(30):
                c.set_default(name)
                assert c.default() in (OFFICE, "second")
        except Exception as exc:  # noqa: BLE001 - reported below
            errors.append(exc)

    threads = [threading.Thread(target=add) for _ in range(4)]
    threads += [threading.Thread(target=flip, args=(n,)) for n in (OFFICE, "second", OFFICE, "second")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert sorted(names) == ["azure", "azure-2", "azure-3", "azure-4"]
    assert json.loads((c.dir / "_default.json").read_text())["name"] in (OFFICE, "second")
    assert not [p for p in c.dir.iterdir() if p.name.startswith(".")]


def test_a_removed_name_is_never_reused(tmp_path):
    office = office_dir(tmp_path)
    c = Connections(office)
    c.put("anthropic", ConnectionFile(llm_config={"provider": "anthropic", "api_key": SENTINEL}))
    c.remove("anthropic")
    assert Connections(office).add("anthropic", api_key()) == "anthropic-2"
    with pytest.raises(ValueError, match="removed"):
        c.put("anthropic", ConnectionFile(llm_config={"provider": "anthropic", "api_key": SENTINEL}))
    assert c.names() == [OFFICE, "anthropic-2"]


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
            c.add("anthropic", api_key())


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
    assert read_run_record(path) == RunRecord(connection=OFFICE, model=None, config=config_hash(Provider()),
                                              target=target_hash(Provider()))
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
    log = run_started_log(tmp_path / "runs" / "r1.jsonl", openai(BASE), openai(BASE.rstrip("/")))
    assert recorded_endpoints(log) == {("openai", BASE.rstrip("/"))}
    for exact in (True, False):
        assert c.for_run(None, log, exact=exact) == c.resolve(OFFICE, None)
    run_started_log(log, openai(BASE), openai("https://elsewhere.example/v1/"))
    with pytest.raises(RunMoved, match="run r1 has no record and ran on another provider or endpoint"):
        c.for_run(None, log, exact=True)
    run_started_log(log, openai())
    with pytest.raises(RunMoved):
        c.for_run(None, log, exact=True)
    log.write_text("{not json\n")
    assert recorded_endpoints(log) is None
    with pytest.raises(RunMoved, match="run r1 has no record"):
        c.for_run(None, log, exact=False)
    log.write_text('{"kind":"node_started","payload":{}}\n')
    assert recorded_endpoints(log) is None
    log.unlink()
    assert recorded_endpoints(log) is None
    with pytest.raises(RunMoved, match="run r1 has no record"):
        c.for_run(None, log, exact=True)


def test_a_run_without_a_record_and_no_base_url_matches_an_office_on_the_same_provider(tmp_path):
    c = Connections(office_dir(tmp_path, {"llm_config": {"provider": "anthropic", "api_key": SENTINEL}}))
    log = run_started_log(tmp_path / "runs" / "r1.jsonl", {"provider": "anthropic", "model": "m", "_host_key": True})
    assert recorded_endpoints(log) == {("anthropic", None)}
    assert c.for_run(None, log, exact=True) == c.resolve(OFFICE, None)


def test_a_run_without_a_record_from_another_provider_is_refused(tmp_path):
    # Neither side has a base_url, so a check on base_url alone would take this openai run as anthropic's.
    office = office_dir(tmp_path, {"llm_config": {"provider": "anthropic", "api_key": SENTINEL}})
    c = Connections(office)
    log = run_started_log(tmp_path / "runs" / "r1.jsonl", openai())
    assert recorded_endpoints(log) == {("openai", "https://api.openai.com/v1")}
    for exact in (True, False):
        with pytest.raises(RunMoved, match="another provider or endpoint"):
            c.for_run(None, log, exact=exact)
    run_started_log(log, {"provider": "anthropic", "model": "m"}, openai())
    with pytest.raises(RunMoved):
        c.for_run(None, log, exact=True)


def test_a_run_without_a_record_follows_the_endpoint_the_environment_gave(tmp_path):
    office = office_dir(tmp_path, {"llm_config": {"provider": "openai", "api_key": SENTINEL, "model": "m"},
                                   "env": {"OPENAI_BASE_URL": "https://proxy.example/v1/"}})
    c = Connections(office)
    pinned = openai(_connection={"kind": "api_key", "endpoint": "https://proxy.example/v1"})
    log = run_started_log(tmp_path / "runs" / "r1.jsonl", pinned)
    assert office_endpoint(c.resolve(OFFICE, None)) == ("openai", "https://proxy.example/v1")
    assert c.for_run(None, log, exact=True) == c.resolve(OFFICE, None)
    write_private(office / "provider.json", json.dumps(
        {"llm_config": {"provider": "openai", "api_key": SENTINEL, "model": "m"},
         "env": {"OPENAI_BASE_URL": "https://other-proxy.example/v1"}}).encode())
    with pytest.raises(RunMoved, match="another provider or endpoint"):
        c.for_run(None, log, exact=True)
    write_private(office / "provider.json", json.dumps(
        {"llm_config": {"provider": "openai", "api_key": SENTINEL, "model": "m"}}).encode())
    with pytest.raises(RunMoved, match="another provider or endpoint"):  # now composer's default endpoint
        c.for_run(None, log, exact=True)
    run_started_log(log, openai())  # an old record with no _connection, which composer pins to its default
    assert c.for_run(None, log, exact=True) == c.resolve(OFFICE, None)


def test_a_run_without_a_record_or_models_matches_office(tmp_path):
    # Composer keeps no key for a run whose models don't use it, so such a run reaches no endpoint.
    c = Connections(office_dir(tmp_path, {"llm_config": {"provider": "anthropic", "api_key": SENTINEL}}))
    log = run_started_log(tmp_path / "runs" / "r1.jsonl")
    assert recorded_endpoints(log) == set()
    assert c.for_run(None, log, exact=True) == c.resolve(OFFICE, None)


def test_a_run_without_a_record_on_an_unusable_office_raises_run_moved(tmp_path):
    office = office_dir(tmp_path)
    (office / "provider.json").write_text("{}")
    (office / "provider.json").chmod(0o644)
    log = run_started_log(tmp_path / "runs" / "r1.jsonl")
    with pytest.raises(RunMoved, match="private"):
        Connections(office).for_run(None, log, exact=True)


def test_for_run_raises_only_run_moved(tmp_path):
    c = Connections(office_dir(tmp_path))
    log = tmp_path / "runs" / "r1.jsonl"
    for bad in ("../x", "default", ""):
        record = RunRecord(connection=bad, model=None, config="c", target="t")
        with pytest.raises(RunMoved, match="names no connection"):
            c.for_run(record, log, exact=True)
    c.put("chatgpt", subscription())
    record = RunRecord(connection="chatgpt", model=None, config="c", target="t")
    with pytest.raises(RunMoved, match="no sign-in"):
        c.for_run(record, log, exact=False)
    c.put("broken", api_key())
    (c.dir / "broken.json").chmod(0o644)
    with pytest.raises(RunMoved, match="private"):
        c.for_run(RunRecord(connection="broken", model=None, config="c", target="t"), log, exact=True)


def test_a_run_record_refuses_unknown_fields(tmp_path):
    path = tmp_path / "r1.model.json"
    path.write_text('{"connection": "office", "model": null, "config": "c", "target": "t", "extra": 1}')
    with pytest.raises(ValueError):
        read_run_record(path)


def test_an_env_change_trips_both_hashes():
    before = Provider(llm_config={"provider": "openai", "api_key": SENTINEL, "model": "m"})
    after = Provider(llm_config=before.llm_config, env={"OPENAI_BASE_URL": "https://proxy.example/v1"})
    assert config_hash(before) != config_hash(after)
    assert target_hash(before) != target_hash(after)

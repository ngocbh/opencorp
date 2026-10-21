"""The secret values the office holds that a run log may echo: what counts, failing closed, the time limit, one read
at a time, and the caches."""

import asyncio
import json
import threading
import time

import pytest

from opencorp.chat.connections import ConnectionFile, Connections
from opencorp.company.git import CompanyGit
from opencorp.runs import known as known_mod
from opencorp.runs.known import KnownValues, SecretsUnavailable, office_values
from opencorp.secrets import SecretStore, write_private
from tests.company.conftest import _isolate_git, base_files, person, write_repo  # noqa: F401

KEY = "conn-key-5f3a9c1e7b2d4a60"
OTHER = "conn-key-other-9d8c7b6a5f40"
AZURE = "azure-ad-token-abcdef012345"
HEADER = "Basic header-secret-0123"
ACCESS = "subscription-access-token-abc"
REFRESH = "subscription-refresh-token-def"
ACCOUNT = "acct-visible-0001-0002"
ASSET = "asset-secret-value-7777"
UNNAMED = "unnamed-secret-value-8888"
PHC = "$scrypt$ln=15,r=8,p=1$c2FsdHNhbHRzYWx0c2FsdA$Z2lHqGqVnSkfU3gS2tlFp2Yzqm7AAw0EC5lyE4X4bMI"
DEFAULT_KEY = "yian-default-store-key-0123"
CREDENTIAL_ID = "c0ffee" * 5 + "ab"


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    """A home of the test's own, so Yian's default store is never the real one."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)


def yian_store(credentials, method="subscription"):
    """A Yian credential store (yian/llm_clients/auth/store.py ``_write``) with one login holding ``credentials``."""
    return (json.dumps({"version": 1, "default_provider": "openai", "providers": {"openai": {
        "method": method, "model": "gpt-5", "credential_id": CREDENTIAL_ID, "credentials": credentials}}},
        sort_keys=True) + "\n").encode()


@pytest.fixture
def company_git(tmp_path):
    files = base_files() | {
        "assets/db.yaml": {"id": "db", "kind": "fake", "tools": {"echo": {}}, "grants": [],
                           "secrets": ["db_password", "Bad Name!"]},
        "people/ngocbh/person.yaml": person("ngocbh", password_hash=PHC)}
    return CompanyGit(write_repo(tmp_path / "company", files), tmp_path / "worktrees")


def an_office(tmp_path, key=KEY):
    office = tmp_path / "office"
    office.mkdir(mode=0o700, exist_ok=True)
    write_private(office / "provider.json", json.dumps(
        {"llm_config": {"provider": "vllm", "model": "stub", "api_key": key}}).encode())
    return office


def sources(tmp_path, company_git):
    connections = Connections(an_office(tmp_path))
    secrets = SecretStore(tmp_path / "secrets")
    secrets.set("db_password", ASSET)
    return connections, secrets


def a_known(tmp_path, company_git, **kwargs):
    connections, secrets = sources(tmp_path, company_git)
    return KnownValues(connections=connections, secrets=secrets, git=company_git, **kwargs)


def test_known_values_are_the_secrets_not_everything_in_the_files(tmp_path, company_git):
    connections, secrets = sources(tmp_path, company_git)
    connections.put("azure", ConnectionFile(llm_config={
        "provider": "azure", "model": "gpt", "azure_ad_token": AZURE, "default_headers": {"Authorization": HEADER},
        "api_version": "2024-10-21-preview"}))
    write_private(connections.dir / "pro.auth.json", yian_store({"access_token": ACCESS, "refresh_token": REFRESH,
                                                                 "expires_at": 1792000000.0, "account_id": ACCOUNT,
                                                                 "residency": None}))
    found = office_values(connections, secrets)
    assert {KEY, AZURE, HEADER, ACCESS, REFRESH, ASSET} <= found
    # values and keys that aren't secrets
    assert not {ACCOUNT, CREDENTIAL_ID, "access_token", "2024-10-21-preview"} & found
    assert PHC in KnownValues(connections=connections, secrets=secrets, git=company_git).values()


def test_every_secret_in_the_store_counts_whatever_names_it(tmp_path, company_git):
    known = a_known(tmp_path, company_git)
    known.secrets.set("unnamed_secret", UNNAMED)  # no asset names it
    (company_git.root / "assets" / "broken.yaml").write_text("id: broken\nkind: fake\ntools: [not, a, dict]\n"
                                                             "secrets: [db_password]\n")
    company_git.commit(["assets/broken.yaml"], "an asset that doesn't load")
    assert {ASSET, UNNAMED} <= known.values()


def test_a_secret_file_edited_in_place_is_seen_at_once(tmp_path, company_git):
    known = a_known(tmp_path, company_git)
    assert ASSET in known.values()
    path = known.secrets.root / "db_password"
    with open(path, "r+") as f:  # by hand: same file, same size, same second
        f.write("Z")
    assert "Z" + ASSET[1:] in known.values() and ASSET not in known.values()


def test_a_store_secret_that_cant_be_read_fails_closed(tmp_path, company_git):
    known = a_known(tmp_path, company_git)
    (known.secrets.root / "db_password").chmod(0o644)
    with pytest.raises(SecretsUnavailable):
        known.values()


def test_yians_default_store_counts_and_a_change_to_it_is_seen(tmp_path, company_git):
    known = a_known(tmp_path, company_git)
    default = tmp_path / "home" / ".config" / "yian"
    default.mkdir(parents=True, mode=0o700)
    write_private(default / "auth.json", yian_store({"api_key": DEFAULT_KEY}, method="api_key"))
    found = known.values()
    assert DEFAULT_KEY in found and CREDENTIAL_ID not in found
    write_private(default / "auth.json", yian_store({"api_key": OTHER}, method="api_key"))  # a new login
    assert OTHER in known.values() and DEFAULT_KEY not in known.values()


def test_the_store_under_home_counts_when_xdg_config_home_points_elsewhere(tmp_path, company_git, monkeypatch):
    known = a_known(tmp_path, company_git)
    default = tmp_path / "home" / ".config" / "yian"  # where a worker, which inherits only HOME, keeps its logins
    default.mkdir(parents=True, mode=0o700)
    write_private(default / "auth.json", yian_store({"api_key": DEFAULT_KEY}, method="api_key"))
    (tmp_path / "xdg").mkdir()
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    assert DEFAULT_KEY in known.values()
    (tmp_path / "xdg" / "yian").mkdir(mode=0o700)
    write_private(tmp_path / "xdg" / "yian" / "auth.json", yian_store({"api_key": OTHER}, method="api_key"))
    assert {DEFAULT_KEY, OTHER} <= known.values()  # the office's own store, under XDG_CONFIG_HOME, counts too


@pytest.mark.parametrize("var, path", [
    ("XDG_CONFIG_HOME", "xdg/yian/auth.json"),
    ("HOME", "elsewhere/.config/yian/auth.json"),
    ("YIAN_AUTH_FILE", "own/auth.json"),
])
def test_a_store_a_connections_env_names_counts(tmp_path, company_git, var, path):
    known = a_known(tmp_path, company_git)
    store = tmp_path / path
    store.parent.mkdir(parents=True, mode=0o700)
    write_private(store, yian_store({"api_key": OTHER}, method="api_key"))
    value = str(tmp_path / path.partition("/")[0]) if var != "YIAN_AUTH_FILE" else str(store)
    if var == "YIAN_AUTH_FILE":  # only office/provider.json may set it
        write_private(known.connections.office / "provider.json", json.dumps(
            {"llm_config": {"provider": "vllm", "model": "stub", "api_key": KEY}, "env": {var: value}}).encode())
    else:
        known.connections.put("other", ConnectionFile(llm_config={"provider": "vllm", "model": "m"},
                                                      env={var: value}))
    assert OTHER in known.values()


@pytest.mark.parametrize("var", ["XDG_CONFIG_HOME", "HOME"])
def test_a_relative_store_path_in_a_connections_env_fails_closed(tmp_path, company_git, var):
    known = a_known(tmp_path, company_git)
    known.connections.put("other", ConnectionFile(llm_config={"provider": "vllm", "model": "m"}, env={var: "rel/dir"}))
    with pytest.raises(SecretsUnavailable):
        known.values()


def test_yians_default_store_that_cant_be_read_fails_closed(tmp_path, company_git):
    known = a_known(tmp_path, company_git)
    default = tmp_path / "home" / ".config" / "yian"
    default.mkdir(parents=True, mode=0o700)
    (default / "auth.json").write_bytes(yian_store({"api_key": DEFAULT_KEY}, method="api_key"))
    (default / "auth.json").chmod(0o644)  # not private: read_private refuses it
    with pytest.raises(SecretsUnavailable):
        known.values()


def test_a_connection_file_that_cant_be_read_fails_closed(tmp_path, company_git):
    office = an_office(tmp_path)
    write_private(office / "provider.json", b"{")
    known = KnownValues(connections=Connections(office), secrets=SecretStore(tmp_path / "s"), git=company_git)
    with pytest.raises(SecretsUnavailable):
        known.values()


def test_a_company_that_cant_be_read_fails_closed_not_with_a_500(tmp_path, company_git, monkeypatch):
    known = a_known(tmp_path, company_git)
    monkeypatch.setattr(company_git, "list_tree", lambda sha: (_ for _ in ()).throw(RuntimeError("bad tree")))
    with pytest.raises(SecretsUnavailable):
        known.values()


async def test_known_values_past_their_limit_are_unavailable(tmp_path, company_git, monkeypatch):
    known = a_known(tmp_path, company_git, limit=0.1)
    monkeypatch.setattr(known, "values", lambda: time.sleep(1))
    with pytest.raises(SecretsUnavailable):
        await known.scrubber()


async def test_a_read_past_its_limit_is_waited_for_not_started_again(tmp_path, company_git, monkeypatch):
    known = a_known(tmp_path, company_git, limit=0.05)
    release, calls, real = threading.Event(), [], known.values
    monkeypatch.setattr(known, "values", lambda: (calls.append(1), release.wait(5), real())[2])
    for _ in range(3):
        with pytest.raises(SecretsUnavailable):
            await known.scrubber()
    assert len(calls) == 1  # one thread, however many requests time out
    release.set()
    known.limit = 5
    # The next request waits for the hung read to end, then reads afresh: that read began before it came.
    assert KEY in (await known.scrubber()).known and len(calls) == 2


async def test_requests_at_once_share_reads(tmp_path, company_git, monkeypatch):
    known = a_known(tmp_path, company_git)
    calls, real = [], known.values
    monkeypatch.setattr(known, "values", lambda: (calls.append(1), time.sleep(0.05), real())[2])
    got = await asyncio.gather(*(known.scrubber() for _ in range(5)))
    assert len({id(s) for s in got}) == 1 and len(calls) <= 2


async def test_scrubbers_and_person_secrets_are_cached(tmp_path, company_git, monkeypatch):
    known = a_known(tmp_path, company_git)
    calls, real = [], known_mod.person_secrets
    monkeypatch.setattr(known_mod, "person_secrets", lambda *a: (calls.append(1), real(*a))[1])
    first = await known.scrubber()
    assert await known.scrubber() is first and calls == [1] and {KEY, PHC} <= first.known
    an_office(tmp_path, key=OTHER)  # a new key
    again = await known.scrubber()
    assert OTHER in again.known and KEY not in again.known and calls == [1]  # HEAD didn't move
    (company_git.root / "notes.md").write_text("later\n")
    company_git.commit(["notes.md"], "a later commit")
    await known.scrubber()
    assert calls == [1, 1]

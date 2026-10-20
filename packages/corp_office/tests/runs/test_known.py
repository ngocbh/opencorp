"""The secret values the office holds that a run log may echo: what counts, failing closed, the time limit, and the
cache."""

import json
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
PHC = "$scrypt$ln=15,r=8,p=1$c2FsdHNhbHRzYWx0c2FsdA$Z2lHqGqVnSkfU3gS2tlFp2Yzqm7AAw0EC5lyE4X4bMI"


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


def test_known_values_are_the_secrets_not_everything_in_the_files(tmp_path, company_git):
    connections, secrets = sources(tmp_path, company_git)
    connections.put("azure", ConnectionFile(llm_config={
        "provider": "azure", "model": "gpt", "azure_ad_token": AZURE, "default_headers": {"Authorization": HEADER},
        "api_version": "2024-10-21-preview"}))
    write_private(connections.dir / "pro.auth.json", json.dumps({"default": "openai", "logins": {"openai": {
        "credentials": {"access_token": ACCESS, "refresh_token": REFRESH, "account_id": ACCOUNT,
                        "expires_at": 1792000000.0}}}}).encode())
    found = office_values(connections, secrets, company_git, company_git.head())
    assert {KEY, AZURE, HEADER, ACCESS, REFRESH, ASSET, PHC} <= found
    assert not {ACCOUNT, "access_token", "2024-10-21-preview"} & found  # values and keys that aren't secrets


def test_a_connection_file_that_cant_be_read_fails_closed(tmp_path, company_git):
    office = an_office(tmp_path)
    write_private(office / "provider.json", b"{")
    known = KnownValues(connections=Connections(office), secrets=SecretStore(tmp_path / "s"), git=company_git)
    with pytest.raises(SecretsUnavailable):
        known.values([])


def test_a_company_that_cant_be_loaded_fails_closed_not_with_a_500(tmp_path, company_git, monkeypatch):
    connections, secrets = sources(tmp_path, company_git)
    monkeypatch.setattr(known_mod, "load_repo", lambda root: (_ for _ in ()).throw(RuntimeError("bad yaml")))
    with pytest.raises(SecretsUnavailable):
        KnownValues(connections=connections, secrets=secrets, git=company_git).values([])


async def test_known_values_past_their_limit_are_unavailable(tmp_path, company_git, monkeypatch):
    connections, secrets = sources(tmp_path, company_git)
    known = KnownValues(connections=connections, secrets=secrets, git=company_git, limit=0.1)
    monkeypatch.setattr(known, "values", lambda pins: time.sleep(1))
    with pytest.raises(SecretsUnavailable):
        await known.scrubber()


async def test_known_values_are_cached_until_what_holds_them_changes(tmp_path, company_git, monkeypatch):
    connections, secrets = sources(tmp_path, company_git)
    clock = [0.0]
    known = KnownValues(connections=connections, secrets=secrets, git=company_git, clock=lambda: clock[0])
    calls, real = [], known_mod.office_values
    monkeypatch.setattr(known_mod, "office_values", lambda *a: (calls.append(1), real(*a))[1])
    first = await known.scrubber()
    assert await known.scrubber() is first and calls == [1] and KEY in first.known
    an_office(tmp_path, key=OTHER)  # a new key: provider.json is a new file
    again = await known.scrubber()
    assert OTHER in again.known and KEY not in again.known and calls == [1, 1]
    clock[0] = known_mod.TTL_S + 1  # nothing changed, but the entry is too old
    await known.scrubber()
    assert calls == [1, 1, 1]


async def test_a_pins_asset_secrets_are_read_once_per_pin(tmp_path, company_git, monkeypatch):
    connections, secrets = sources(tmp_path, company_git)
    known = KnownValues(connections=connections, secrets=secrets, git=company_git)
    pins, real = [], known_mod.pin_values
    monkeypatch.setattr(known_mod, "pin_values", lambda s, g, commit: (pins.append(commit), real(s, g, commit))[1])
    old = company_git.head()  # a session's pin
    (company_git.root / "notes.md").write_text("later\n")
    head = company_git.commit(["notes.md"], "a later commit")  # HEAD moves on
    await known.scrubber([old])
    await known.scrubber([old])
    assert pins.count(old) == 1 and pins.count(head) == 1  # HEAD's are read with the office's part

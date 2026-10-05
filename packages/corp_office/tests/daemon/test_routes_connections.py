"""Connection routes: listing, adding, removing and the default, and who may manage them."""

import json
import logging
import os
import stat

import httpx
import pytest
import yaml
from pydantic import ValidationError

from agent_corp.auth.identity import Identity, identity_path, write_identity
from agent_corp.auth.tokens import new_token
from agent_corp.chat import check, models
from agent_corp.chat.connections import ConnectionFile, Connections, provider_label
from agent_corp.chat.models import Listing, ModelCache, own_models
from agent_corp.chat.provider import ProviderError
from agent_corp.daemon.app import create_app
from agent_corp.protocol.models import ModelOption
from agent_corp.secrets import write_private
from tests.company.conftest import _git
from tests.daemon.test_auth import add_human, bearer, give_device

SENTINEL = "sk-sentinel-0d4c7e19b2a6"
REFUSED = "sk-refused-5e8a1c03f7d2"
"""A key the fake provider refuses."""
UNREACHABLE = "sk-unreachable-93b7f2a05c1e"
"""A key whose provider the fake listing can't reach."""

LISTS = {"azure": ["gpt-5.4", "o3"], "openai": ["chatgpt-4o-latest", "gpt-5.5", "o3"]}


@pytest.fixture
def listings(monkeypatch):
    """Stand in for listing a provider: Azure and OpenAI list ``LISTS``, ``REFUSED`` is refused; records each call."""
    calls = []

    def list_models(conn, name, *, deadline=models.DEADLINE, **kwargs):
        calls.append(name)
        llm = conn.llm_config or {}
        if llm.get("api_key") == REFUSED:
            return own_models(conn, name, "HTTP 401", refused=True)
        if llm.get("api_key") == UNREACHABLE:
            return own_models(conn, name, "can't reach acme.openai.azure.com")
        if (label := provider_label(llm)) in LISTS:
            return Listing(connection=name, models=[ModelOption(id=m) for m in LISTS[label]], listed=True)
        return own_models(conn, name)

    monkeypatch.setattr(models, "list_models", list_models)
    return calls


@pytest.fixture
def checks(monkeypatch):
    """Stand in for the one-reply check: answers the next ``problems`` (None: the model answered); records each."""
    calls, problems = [], []

    def one_reply_problem(provider, **kwargs):
        calls.append(provider)
        return problems.pop(0) if problems else None

    monkeypatch.setattr(check, "one_reply_problem", one_reply_problem)
    return calls, problems


@pytest.fixture
def conns(office, listings, checks):
    office.paths.office.mkdir(mode=0o700, exist_ok=True)
    write_private(office.paths.office / "provider.json",
                  json.dumps({"llm_config": {"provider": "anthropic", "api_key": SENTINEL}}).encode())
    found = Connections(office.paths.office)
    office.extras["connections"] = found
    office.extras["models"] = ModelCache(found, lister=models.list_models)
    return found


@pytest.fixture
def as_owner(office, company, conns):
    token = new_token()
    give_device(company, "ngocbh", "mac", token)
    write_identity(identity_path(office.paths.home), Identity("ngocbh", "mac", token))
    return bearer(token)


@pytest.fixture
def as_ava(company, as_owner):
    add_human(company, "ava")
    token = new_token()
    give_device(company, "ava", "pc", token)
    return bearer(token)


def office_asset(grants):
    return {"id": "offices", "kind": "office", "tools": {"connections": {}}, "grants": grants}


@pytest.fixture
def commit_asset(company):
    def commit(asset):
        (company / "assets" / f"{asset['id']}.yaml").write_text(yaml.safe_dump(asset))
        _git(company, "add", "-A")
        _git(company, "commit", "-qm", f"asset {asset['id']}")
    return commit


def azure_file():
    return ConnectionFile(llm_config={"provider": "openai", "base_url": "https://acme.openai.azure.com/openai/v1/",
                                      "api_key": SENTINEL, "model": "gpt-5.4"})


def saved(office, name):
    return json.loads((office.paths.office / "connections" / f"{name}.json").read_text())


async def test_everyone_signed_in_sees_connections_without_keys(client, conns, as_ava, as_owner):
    conns.put("azure", azure_file())
    r = await client.get("/connections", headers=as_ava)
    assert r.status_code == 200 and SENTINEL not in r.text
    assert r.json() == {"connections": [
        {"name": "office", "provider": "anthropic", "method": "api_key", "model": None, "default": True},
        {"name": "azure", "provider": "azure", "method": "api_key", "model": "gpt-5.4", "default": False},
    ], "default": "office", "can_manage": False}
    assert (await client.get("/connections", headers=as_owner)).json()["can_manage"] is True


async def test_the_owner_adds_a_connection(client, office, as_owner, caplog):
    caplog.set_level(logging.DEBUG)
    r = await client.post("/connections", json={"provider": "openai", "api_key": SENTINEL}, headers=as_owner)
    assert (r.status_code, r.json()) == (200, {"name": "openai", "provider": "openai", "method": "api_key",
                                               "model": "gpt-5.5", "default": False})
    path = office.paths.office / "connections" / "openai.json"
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert saved(office, "openai")["llm_config"] == {"provider": "openai", "api_key": SENTINEL, "model": "gpt-5.5"}
    r = await client.post("/connections", json={"provider": "openai", "api_key": SENTINEL, "model": "o3"},
                          headers=as_owner)
    assert r.json()["name"] == "openai-2" and r.json()["model"] == "o3"
    listed = await client.get("/connections", headers=as_owner)
    assert SENTINEL not in r.text + listed.text + caplog.text
    assert [e for e in office.store.events_after() if SENTINEL in json.dumps(e.model_dump(mode="json"))] == []


async def test_a_listed_provider_without_a_default_takes_its_first_model(client, as_owner):
    r = await client.post("/connections", json={"provider": "azure", "api_key": SENTINEL, "endpoint": "acme"},
                          headers=as_owner)
    assert r.json()["model"] == "gpt-5.4"


async def test_a_model_the_listing_doesnt_offer_is_not_saved(client, office, as_owner, checks):
    for body in ({"provider": "openai", "api_key": SENTINEL, "model": "gpt5-prod"},
                 {"provider": "azure", "api_key": SENTINEL, "endpoint": "acme", "model": "gpt5-prod"}):
        r = await client.post("/connections", json=body, headers=as_owner)
        assert (r.status_code, r.json()) == (422, {"error": "model_not_offered",
                                                   "message": "This connection doesn't offer 'gpt5-prod'"})
    assert not (office.paths.office / "connections").exists() and checks[0] == []


async def test_azure_needs_an_endpoint_and_gets_its_v1_url(client, office, as_owner, checks):
    r = await client.post("/connections", json={"provider": "azure", "api_key": SENTINEL}, headers=as_owner)
    assert (r.status_code, r.json()["error"]) == (422, "invalid_connection")
    assert not (office.paths.office / "connections").exists()
    r = await client.post("/connections", json={"provider": "azure", "api_key": SENTINEL, "endpoint": "acme",
                                                "model": "o3"}, headers=as_owner)
    assert (r.status_code, r.json()["name"], r.json()["provider"], r.json()["model"]) == (200, "azure", "azure", "o3")
    assert saved(office, "azure")["llm_config"] == {
        "provider": "openai", "base_url": "https://acme.openai.azure.com/openai/v1/", "api_key": SENTINEL,
        "model": "o3"}
    assert checks[0] == []  # listing was the check


async def test_other_takes_a_base_url_and_needs_a_model(client, office, as_owner, checks):
    body = {"provider": "openai", "api_key": SENTINEL, "endpoint": "https://gw.example/v1"}
    r = await client.post("/connections", json=body, headers=as_owner)
    assert (r.status_code, r.json()["error"]) == (422, "invalid_connection")
    r = await client.post("/connections", json=body | {"model": "llama-4"}, headers=as_owner)
    assert (r.status_code, r.json()["name"], r.json()["provider"]) == (200, "custom", "custom")
    assert saved(office, "custom")["llm_config"] == {"provider": "openai", "base_url": "https://gw.example/v1",
                                                     "api_key": SENTINEL, "model": "llama-4"}
    [checked] = checks[0]
    assert checked.llm_config["model"] == "llama-4"


async def test_an_endpoint_is_only_for_azure_or_openai(client, as_owner):
    r = await client.post("/connections", json={"provider": "anthropic", "api_key": SENTINEL,
                                                "endpoint": "https://gw.example/v1"}, headers=as_owner)
    assert (r.status_code, r.json()["error"]) == (422, "invalid_connection")


async def test_a_refused_key_is_not_saved(client, office, as_owner, checks):
    for body in ({"provider": "openai", "api_key": REFUSED},
                 {"provider": "azure", "api_key": REFUSED, "endpoint": "acme"}):
        r = await client.post("/connections", json=body, headers=as_owner)
        assert (r.status_code, r.json()) == (422, {"error": "key_refused",
                                                   "message": "The key didn't work (HTTP 401)"})
    assert not (office.paths.office / "connections").exists() and checks[0] == []


async def test_azure_that_cant_list_needs_a_model_to_check(client, office, as_owner, checks):
    calls, _ = checks
    body = {"provider": "azure", "api_key": UNREACHABLE, "endpoint": "acme"}
    r = await client.post("/connections", json=body, headers=as_owner)
    assert (r.status_code, r.json()) == (422, {
        "error": "models_unlisted",
        "message": "Couldn't list the deployments (can't reach acme.openai.azure.com); name a model to check it with "
                   "one reply"})
    assert calls == [] and not (office.paths.office / "connections").exists()
    r = await client.post("/connections", json=body | {"model": "gpt-5.4"}, headers=as_owner)
    assert (r.status_code, r.json()["name"], r.json()["model"]) == (200, "azure", "gpt-5.4")
    [checked] = calls
    assert checked.llm_config["model"] == "gpt-5.4"


async def test_a_provider_that_cant_list_gets_a_one_reply_check(client, office, as_owner, checks):
    calls, problems = checks
    body = {"provider": "anthropic", "api_key": SENTINEL, "model": "claude-x"}
    r = await client.post("/connections", json=body, headers=as_owner)
    assert (r.status_code, r.json()["name"], r.json()["model"]) == (200, "anthropic", "claude-x")
    assert calls[0].llm_config == {"provider": "anthropic", "api_key": SENTINEL, "model": "claude-x"}
    problems.append("Error code: 404 - model not found")
    r = await client.post("/connections", json=body, headers=as_owner)
    assert (r.status_code, r.json()) == (422, {"error": "model_refused",
                                               "message": "The model didn't answer: Error code: 404 - model not found"})
    assert sorted(os.listdir(office.paths.office / "connections")) == ["anthropic.json"]


async def test_others_are_refused_before_the_body_is_read(client, office, as_ava):
    for method, path in [("POST", "/connections"), ("DELETE", "/connections/office"),
                         ("DELETE", "/connections/nope"), ("PUT", "/connections/default")]:
        r = await client.request(method, path, content=b"not json", headers=as_ava)
        assert (r.status_code, r.json()["error"]) == (403, "forbidden")
    assert not (office.paths.office / "connections").exists()


async def test_a_grant_lets_ava_manage(client, as_ava, commit_asset):
    commit_asset(office_asset([{"who": "ava", "can": ["connections"]}]))
    assert (await client.get("/connections", headers=as_ava)).json()["can_manage"] is True
    r = await client.post("/connections", json={"provider": "openai", "api_key": SENTINEL}, headers=as_ava)
    assert r.status_code == 200


async def test_an_uncommitted_grant_doesnt_count(client, as_ava, company):
    (company / "assets" / "offices.yaml").write_text(yaml.safe_dump(office_asset([{"who": "ava", "can": ["admin"]}])))
    r = await client.post("/connections", json={"provider": "openai", "api_key": SENTINEL}, headers=as_ava)
    assert r.status_code == 403
    assert (await client.get("/connections", headers=as_ava)).json()["can_manage"] is False


async def test_office_cannot_be_removed(client, as_owner):
    r = await client.delete("/connections/office", headers=as_owner)
    assert (r.status_code, r.json()["error"]) == (422, "set_up_by_onboard")


async def test_a_removed_name_comes_back_as_a_new_name(client, office, as_owner):
    body = {"provider": "azure", "api_key": SENTINEL, "endpoint": "acme"}
    assert (await client.post("/connections", json=body, headers=as_owner)).json()["name"] == "azure"
    r = await client.delete("/connections/azure", headers=as_owner)
    assert (r.status_code, r.json()) == (200, {"ok": True})
    assert (await client.post("/connections", json=body, headers=as_owner)).json()["name"] == "azure-2"
    names = [c["name"] for c in (await client.get("/connections", headers=as_owner)).json()["connections"]]
    assert names == ["office", "azure-2"]
    assert (await client.delete("/connections/azure", headers=as_owner)).status_code == 404


async def test_a_remove_that_cant_get_the_sign_in_lock_is_409(client, conns, as_owner, monkeypatch):
    conns.put("azure", azure_file())

    def remove(name):
        raise ProviderError("the sign-in of connection 'azure' is busy; try again")

    monkeypatch.setattr(conns, "remove", remove)
    r = await client.delete("/connections/azure", headers=as_owner)
    assert (r.status_code, r.json()["error"]) == (409, "connection_unusable")


async def test_an_unexpected_value_error_is_a_500_not_a_404(office, conns, as_owner, monkeypatch):
    try:
        ConnectionFile.model_validate({"llm_config": 5})
    except ValidationError as exc:
        invalid = exc

    def remove(name):
        raise invalid

    monkeypatch.setattr(conns, "remove", remove)
    transport = httpx.ASGITransport(app=create_app(office), raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
        r = await c.delete("/connections/azure", headers=as_owner)
    assert (r.status_code, r.json()) == (500, {"error": "internal_error", "message": "internal error"})


async def test_a_default_whose_file_cant_be_read_is_still_the_default(client, office, conns, as_owner):
    conns.put("azure", azure_file())
    conns.set_default("azure")
    write_private(office.paths.office / "connections" / "azure.json", b"{not json")
    r = await client.get("/connections", headers=as_owner)
    assert r.status_code == 200
    assert (r.json()["default"], [(c["name"], c["default"]) for c in r.json()["connections"]]) == (
        "azure", [("office", False)])


async def test_unknown_names_are_404(client, as_owner):
    for method, path, body in [("DELETE", "/connections/nope", None), ("DELETE", "/connections/Bad_Name", None),
                               ("GET", "/connections/nope/models", None), ("GET", "/connections/login/models", None),
                               ("PUT", "/connections/default", {"connection": "nope"})]:
        r = await client.request(method, path, json=body, headers=as_owner)
        assert (r.status_code, r.json()["error"]) == (404, "not_found"), path


async def test_set_default(client, conns, as_owner):
    conns.put("azure", azure_file())
    r = await client.put("/connections/default", json={"connection": "azure"}, headers=as_owner)
    assert r.status_code == 200
    assert (r.json()["default"], [c["default"] for c in r.json()["connections"]]) == ("azure", [False, True])
    assert conns.default() == "azure"
    r = await client.put("/connections/default", json={"connection": "Bad"}, headers=as_owner)
    assert (r.status_code, r.json()["error"]) == (422, "invalid_body")


async def test_models_route_lists_and_unknown_connection_is_404(client, conns, as_ava, listings):
    conns.put("azure", azure_file())
    r = await client.get("/connections/azure/models", headers=as_ava)
    assert (r.status_code, r.json()) == (200, {"connection": "azure", "models": [{"id": "gpt-5.4", "name": None},
                                                                                {"id": "o3", "name": None}],
                                               "listed": True, "error": None})
    await client.get("/connections/azure/models", headers=as_ava)
    assert listings == ["azure"]
    await client.get("/connections/azure/models?refresh=1", headers=as_ava)
    assert listings == ["azure", "azure"]
    r = await client.get("/connections/office/models", headers=as_ava)
    assert r.json() == {"connection": "office", "models": [], "listed": False, "error": None}
    r = await client.get("/connections/nope/models", headers=as_ava)
    assert (r.status_code, r.json()["error"]) == (404, "not_found")


async def test_a_malformed_add_never_echoes_the_key(client, office, as_owner):
    for body in ({"provider": "openai", "api_key": SENTINEL, SENTINEL: SENTINEL},
                 {"provider": SENTINEL, "api_key": SENTINEL},
                 {"provider": "openai", "api_key": SENTINEL, "endpoint": SENTINEL},
                 {"provider": "openai", "api_key": SENTINEL, "model": 5},
                 {"provider": ["openai"], "api_key": SENTINEL}):
        r = await client.post("/connections", json=body, headers=as_owner)
        assert r.status_code == 422 and SENTINEL not in r.text, body
    r = await client.post("/connections", content=f'{{"api_key": "{SENTINEL}"'.encode(), headers=as_owner)
    assert r.status_code == 422 and SENTINEL not in r.text
    assert not (office.paths.office / "connections").exists()

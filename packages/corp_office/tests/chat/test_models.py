"""Listing the models a connection offers, and the cache of those lists."""

import json
import re
import threading
import time

import httpx
import pytest
from agent_composer.llm_clients.auth import HttpResponse, OpenAIAuth

from agent_corp.chat.connections import ConnectionFile, ConnectionGone, Connections
from agent_corp.chat.models import (FRESH, TIMED_OUT, ListTimeout, ModelCache, ModelListError, azure_deployments,
                                    list_models)
from agent_corp.protocol.models import ModelList, ModelOption
from agent_corp.secrets import write_private

SENTINEL = "sk-sentinel-3c9e10b7a2f4"
AZURE = "https://acme.openai.azure.com/openai/v1/"


def azure(model="gpt-5.4"):
    return ConnectionFile(llm_config={"provider": "openai", "base_url": AZURE, "api_key": SENTINEL, "model": model})


def openai(model="gpt-5"):
    return ConnectionFile(llm_config={"provider": "openai", "api_key": SENTINEL, "model": model})


def deployments_reply(request):
    data = [{"id": "gpt-5.4", "model": "gpt-5.4", "status": "succeeded"},
            {"id": "embed", "model": "text-embedding-3-small", "status": "succeeded"},
            {"id": "new", "model": "gpt-5.6", "status": "creating"},
            {"id": "o3", "model": "o3", "status": "succeeded"}]
    return httpx.Response(200, json={"data": data, "object": "list"})


class FakeRequest:
    """Composer's ``request`` callable for ``OpenAIAuth``: answers every call with ``response``, recording it."""

    def __init__(self, response):
        self.response = response
        self.calls = []

    def __call__(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        return self.response


def test_azure_lists_ready_chat_deployments():
    seen = []

    def handler(request):
        seen.append(request)
        return deployments_reply(request)

    assert azure_deployments(AZURE, SENTINEL, timeout=5, transport=httpx.MockTransport(handler)) == ["gpt-5.4", "o3"]
    [request] = seen
    assert str(request.url) == "https://acme.openai.azure.com/openai/deployments?api-version=2022-12-01"
    assert request.headers["api-key"] == SENTINEL
    got = list_models(azure(), "azure", transport=httpx.MockTransport(deployments_reply))
    assert got.model_dump() == ModelList(connection="azure", models=[ModelOption(id="gpt-5.4"), ModelOption(id="o3")],
                                         listed=True).model_dump()


@pytest.mark.parametrize(("response", "problem"), [
    (httpx.Response(401, json={"error": {"message": SENTINEL}}), "HTTP 401"),
    (httpx.Response(200, text="<html>"), "the reply isn't a deployment list"),
    (httpx.Response(200, json={"data": "x"}), "the reply isn't a deployment list"),
    (httpx.ConnectError("boom"), "can't reach acme.openai.azure.com"),
    (httpx.ReadTimeout("slow"), TIMED_OUT),
])
def test_azure_deployments_says_why_it_cant_list_them(response, problem):
    def handler(request):
        if isinstance(response, Exception):
            raise response
        return response

    with pytest.raises(ModelListError, match=f"^{re.escape(problem)}$"):
        azure_deployments(AZURE, SENTINEL, timeout=5, transport=httpx.MockTransport(handler))


def test_openai_with_a_key_lists_text_models():
    ids = ["gpt-5", "dall-e-3", "gpt-4o-realtime-preview", "o3", "text-embedding-3-small", "gpt-4o-mini-tts", "o4-mini"]
    request = FakeRequest(HttpResponse(200, {"data": [{"id": i} for i in ids]}))
    got = list_models(openai(), "openai", deadline=6, auth=OpenAIAuth(request=request, request_timeout=6))
    assert [m.id for m in got.models] == ["gpt-5", "o3", "o4-mini"] and got.listed and got.error is None
    [(method, url, kwargs)] = request.calls
    assert (method, url) == ("GET", "https://api.openai.com/v1/models")
    assert kwargs["headers"]["Authorization"] == f"Bearer {SENTINEL}" and kwargs["timeout"] <= 6


@pytest.mark.parametrize("status", [401, 403])
def test_a_refused_key_says_the_status_never_the_key(status):
    request = FakeRequest(HttpResponse(status, {"error": {"message": f"bad key {SENTINEL}"}}))
    got = list_models(openai(), "openai", auth=OpenAIAuth(request=request))
    assert (got.error, got.refused) == (f"HTTP {status}", True)
    assert SENTINEL not in got.model_dump_json() and "refused" not in got.model_dump()
    got = list_models(azure(), "azure", transport=httpx.MockTransport(lambda r: httpx.Response(status)))
    assert (got.error, got.refused) == (f"HTTP {status}", True)


def test_a_failure_that_isnt_a_refusal_isnt_refused():
    got = list_models(openai(), "openai", auth=OpenAIAuth(request=FakeRequest(HttpResponse(500, {}))))
    assert (got.error, got.refused, got.listed) == ("HTTP 500", False, False)
    assert got.models == [ModelOption(id="gpt-5")]


@pytest.mark.parametrize("conn", [
    ConnectionFile(llm_config={"provider": "anthropic", "api_key": SENTINEL, "model": "claude-x"}),
    ConnectionFile(llm_config={"provider": "openai", "base_url": "https://gw.example/v1", "api_key": SENTINEL,
                               "model": "claude-x"}),
    ConnectionFile(method="subscription", llm_config={"provider": "openai", "model": "claude-x"}),
    ConnectionFile(llm_config={"provider": "openai", "api_key": SENTINEL, "model": "claude-x"},
                   env={"OPENAI_BASE_URL": "https://gw.example/v1"}),
])
def test_a_provider_that_cant_list_gives_its_own_model(conn):
    got = list_models(conn, "other", auth=OpenAIAuth(request=FakeRequest(None)))
    want = ModelList(connection="other", models=[ModelOption(id="claude-x")], listed=False)
    assert got.model_dump() == want.model_dump()
    got = list_models(ConnectionFile(llm_config={"provider": "anthropic", "api_key": SENTINEL}), "other")
    assert (got.models, got.listed) == ([], False)


def test_listing_returns_by_the_deadline():
    release = threading.Event()

    def handler(request):
        release.wait(30)
        return deployments_reply(request)

    start = time.monotonic()
    try:
        got = list_models(azure(), "azure", deadline=0.5, transport=httpx.MockTransport(handler))
    finally:
        release.set()
    assert time.monotonic() - start < 2
    assert (got.error, got.listed, got.models) == (TIMED_OUT, False, [ModelOption(id="gpt-5.4")])


# The cache.


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class Lister:
    """A fake ``list_models``: offers ``models`` (by connection name), waiting first on ``gates`` that name it."""

    def __init__(self, models=None, gates=None):
        self.models = models or {}
        self.gates = gates or {}
        self.calls = []
        self.started = threading.Event()

    def __call__(self, conn, name, *, deadline):
        self.calls.append(name)
        self.started.set()
        if name in self.gates and not self.gates[name].wait(deadline):
            return ModelList(connection=name, models=[], listed=False, error=TIMED_OUT)
        ids = self.models.get(name, ["m"])
        return ModelList(connection=name, models=[ModelOption(id=i) for i in ids], listed=True)


@pytest.fixture
def connections(tmp_path):
    office = tmp_path / "office"
    office.mkdir(mode=0o700)
    write_private(office / "provider.json",
                  json.dumps({"llm_config": {"provider": "anthropic", "api_key": SENTINEL}}).encode())
    conns = Connections(office)
    for name in ("fast", "slow", "second"):
        conns.put(name, openai())
    return conns


def run(fn, *args, **kwargs):
    """Run ``fn`` in a thread; returns the thread and a list that gets its result."""
    out = []
    thread = threading.Thread(target=lambda: out.append(fn(*args, **kwargs)), daemon=True)
    thread.start()
    return thread, out


def test_the_cache_refreshes_after_five_minutes_and_on_refresh(connections):
    lister, clock = Lister(), Clock()
    cache = ModelCache(connections, lister=lister, clock=clock)
    first = cache.get("office")
    assert cache.get("office") is first
    clock.now += FRESH - 1
    assert cache.get("office") is first and lister.calls == ["office"]
    clock.now += 2
    assert cache.get("office") is not first and lister.calls == ["office"] * 2
    cache.get("office", refresh=True)
    assert lister.calls == ["office"] * 3


def test_a_failed_listing_or_a_changed_connection_is_listed_again(connections):
    lister = Lister(gates={"fast": threading.Event()})
    cache = ModelCache(connections, lister=lister)
    assert cache.get("fast", deadline=0.1).error == TIMED_OUT
    lister.gates.clear()
    assert cache.get("fast").error is None and lister.calls == ["fast"] * 2
    connections.put("fast", openai(model="gpt-6"))
    cache.get("fast")
    assert lister.calls == ["fast"] * 3


def test_an_unknown_connection_raises(connections):
    with pytest.raises(ConnectionGone):
        ModelCache(connections, lister=Lister()).get("nope")


def test_warm_lists_every_connection_in_the_background(connections):
    gate = threading.Event()
    lister = Lister(gates={"slow": gate})
    cache = ModelCache(connections, lister=lister)
    start = time.monotonic()
    thread = cache.warm()
    assert time.monotonic() - start < 0.5 and thread.is_alive()
    gate.set()
    thread.join(5)
    assert sorted(lister.calls) == ["fast", "office", "second", "slow"]
    cache.get("slow")
    assert len(lister.calls) == 4


def test_a_caller_waits_for_an_in_flight_listing_instead_of_listing_again(connections):
    gate = threading.Event()
    lister = Lister(gates={"slow": gate})
    cache = ModelCache(connections, lister=lister)
    first, got_first = run(cache.get, "slow")
    assert lister.started.wait(5)
    second, got_second = run(cache.get, "slow")
    time.sleep(0.1)
    gate.set()
    first.join(5)
    second.join(5)
    assert lister.calls == ["slow"] and got_first[0] is got_second[0]


def test_a_slow_connection_never_blocks_another(connections):
    gate = threading.Event()
    cache = ModelCache(connections, lister=Lister(gates={"slow": gate}))
    slow, _ = run(cache.get, "slow")
    try:
        start = time.monotonic()
        assert cache.get("fast").listed
        assert time.monotonic() - start < 1 and slow.is_alive()
    finally:
        gate.set()
        slow.join(5)


def test_offers_uses_an_old_entry_and_lists_a_missing_one(connections):
    lister, clock = Lister(models={"office": ["claude-x"], "second": ["gpt-5", "claude-x"], "fast": ["gpt-5"]}), Clock()
    cache = ModelCache(connections, lister=lister, clock=clock)
    cache.get("office")
    clock.now += 10 * FRESH
    assert cache.offers(["office", "second", "fast"], "claude-x", deadline=5) == ["office", "second"]
    assert lister.calls == ["office", "second", "fast"]


def test_offers_raises_list_timeout_when_the_deadline_passes(connections):
    gates = {"slow": threading.Event(), "second": threading.Event()}
    cache = ModelCache(connections, lister=Lister(gates=gates))
    start = time.monotonic()
    try:
        with pytest.raises(ListTimeout):
            cache.offers(["slow", "second"], "m", deadline=0.5)
    finally:
        for gate in gates.values():
            gate.set()
    assert time.monotonic() - start < 1

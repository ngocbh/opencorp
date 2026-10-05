"""The models each connection offers: listed from its provider, and kept for a few minutes."""

import logging
import re
import threading
import time
from collections.abc import Callable, Iterable
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from agent_composer.llm_clients import ModelListError as HostListError
from agent_composer.llm_clients import list_models as host_models
from agent_composer.llm_clients.auth import AuthError, AuthStore, HttpResponse, OpenAIAuth
from pydantic import Field

from agent_corp.chat.connections import ConnectionFile, Connections, config_hash, provider_label
from agent_corp.chat.provider import Provider, ProviderError
from agent_corp.protocol.models import ModelList, ModelOption

log = logging.getLogger(__name__)

DEADLINE = 8.0
"""Seconds one listing may take, under the TUI's 15 s read timeout."""

FRESH = 300.0
"""Seconds a listing is used before the connection is listed again."""

TIMED_OUT = "timed out"

AZURE_DEPLOYMENTS_API = "2022-12-01"
"""The last Azure OpenAI API version whose data plane lists a resource's deployments with only its key."""

KEYLESS = ("ollama", "vllm")
"""Providers whose runs need no key, so they are listed without one."""

_ENV_BASE_URL = {"ollama": "OLLAMA_BASE_URL", "vllm": "VLLM_BASE_URL"}
"""The variable composer's client for a provider reads its endpoint from when ``llm_config`` gives none."""

_ENV_ELSEWHERE = {
    "openai": ("OPENAI_API_BASE", "OPENAI_BASE_URL"),
    "anthropic": ("ANTHROPIC_API_URL", "ANTHROPIC_BASE_URL"),
    "google": ("GOOGLE_GEMINI_BASE_URL", "GOOGLE_GENAI_USE_VERTEXAI"),
}
"""Variables the SDK under composer's client for a provider reads to send runs to another host than the one
composer lists, when ``llm_config`` gives no endpoint."""


class ModelListError(Exception):
    """Models couldn't be listed; the message says why and never holds the key. ``status`` is the HTTP status of a
    reply that refused the listing."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class ListTimeout(Exception):
    """The deadline passed before every connection asked about was listed."""


class Listing(ModelList):
    """A connection's ``ModelList``, and whether its provider refused the key (never sent to clients)."""

    refused: bool = Field(default=False, exclude=True)


def azure_deployments(base_url: str, key: str, *, timeout: float,
                      transport: httpx.BaseTransport | None = None) -> list[str]:
    """The deployments at the Azure OpenAI resource whose v1 endpoint is ``base_url`` that are ready and not
    embedding models, in Azure's order.

    Raises:
        ModelListError: they couldn't be listed.
    """
    root = base_url.rstrip("/").removesuffix("/openai/v1")
    try:
        with httpx.Client(transport=transport, timeout=timeout) as client:
            reply = client.get(f"{root}/openai/deployments", params={"api-version": AZURE_DEPLOYMENTS_API},
                               headers={"api-key": key})
    except httpx.TimeoutException:
        raise ModelListError(TIMED_OUT) from None
    except httpx.HTTPError:
        raise ModelListError(f"can't reach {urlsplit(root).hostname}") from None
    if reply.status_code != 200:
        raise ModelListError(f"HTTP {reply.status_code}", reply.status_code)
    try:
        data = reply.json()["data"]
        # Entries say no more about what a model can do than its name.
        return [d["id"] for d in data if d.get("status") == "succeeded" and "embedding" not in d.get("model", "")]
    except (ValueError, LookupError, TypeError, AttributeError):
        raise ModelListError("the reply isn't a deployment list") from None


def _text_models(models: tuple[str, ...]) -> list[str]:
    """The general text models among ``models``, as composer's ``composer auth`` offers them."""
    return [
        name
        for name in models
        if name.startswith(("gpt-", "chatgpt-", "o1", "o3", "o4"))
        and not any(part in name for part in ("realtime", "audio", "image", "transcribe", "tts"))
    ]


def provider_models(provider: str, key: str | None, base_url: str | None = None, *, timeout: float,
                    request: Callable[..., HttpResponse] | None = None) -> list[str] | None:
    """The models the host of ``provider`` at ``base_url`` (None: the provider's own) lists for ``key``, sorted, or
    None when the provider has no listing; at OpenAI's own host, only its text models. ``request`` stands in for
    composer's HTTP sender.

    Raises:
        ModelListError: they couldn't be listed.
    """
    try:
        ids = host_models(provider, key, base_url, timeout=timeout, request=request)
    except HostListError as exc:
        # Composer's messages are fixed and safe to show; the status is the part that says whether the key was refused.
        message = str(exc)
        status = re.fullmatch(r"HTTP (\d{3})", message)
        raise ModelListError(message, int(status[1]) if status else None) from None
    if ids is None:
        return None
    return _text_models(ids) if provider == "openai" and base_url is None else list(ids)


def subscription_models(auth_file: Path, *, timeout: float,
                        request: Callable[..., HttpResponse] | None = None) -> list[str]:
    """The models the ChatGPT subscription signed in at ``auth_file`` offers, in its order, refreshing a sign-in about
    to expire first; each request gets what is left of ``timeout``. ``request`` stands in for composer's HTTP sender.

    Raises:
        ModelListError: they couldn't be listed.
    """
    end = time.monotonic() + timeout

    def auth() -> OpenAIAuth:
        remaining = end - time.monotonic()
        if remaining <= 0:
            raise ModelListError(TIMED_OUT)
        return OpenAIAuth(request=request, request_timeout=remaining)

    store = AuthStore(auth_file)
    try:
        selection = store.selection("openai")
        if selection is None:
            raise ModelListError("no sign-in")
        credentials = store.credentials("openai", selection.credential_id, refresh=lambda old: auth().refresh(old))
        return list(auth().subscription_models(credentials))
    except AuthError as exc:
        # Composer's messages are status-only and safe to show.
        message = str(exc)
        status = re.search(r"\(HTTP (\d{3})\)$", message)
        raise ModelListError(message, int(status[1]) if status else None) from None


def _runs_host(llm: dict, env: dict[str, str]) -> tuple[bool, str | None]:
    """Whether the host a connection with ``llm`` and ``env`` runs on is known, and its base URL (None: the
    provider's own)."""
    if base_url := llm.get("base_url"):
        return True, base_url
    provider = llm.get("provider", "")
    if any(name in env for name in _ENV_ELSEWHERE.get(provider, ())):
        return False, None
    return True, env.get(_ENV_BASE_URL.get(provider, ""))


def own_models(conn: Provider, name: str, error: str | None = None, *, refused: bool = False) -> Listing:
    """Connection ``name`` unlisted: it offers only its configured model, and ``error`` says why when it couldn't be
    listed."""
    model = (conn.llm_config or {}).get("model")
    return Listing(connection=name, models=[ModelOption(id=model)] if model else [], listed=False, error=error,
                   refused=refused)


def _listed(conn: Provider, name: str, timeout: float, request: Callable[..., HttpResponse] | None,
            transport: httpx.BaseTransport | None, auth_file: Path | None) -> Listing:
    llm = conn.llm_config or {}
    provider, key = llm.get("provider"), llm.get("api_key")
    known, base_url = _runs_host(llm, conn.env)
    try:
        if auth_file is not None:
            ids = subscription_models(auth_file, timeout=timeout, request=request)
        elif isinstance(key, str) and provider_label(llm) == "azure" and base_url:
            ids = azure_deployments(base_url, key, timeout=timeout, transport=transport)
        # A connection's env can't hold a key, so a key not in llm_config is one its runs don't have either.
        elif not provider or not known or not (isinstance(key, str) or provider in KEYLESS):
            return own_models(conn, name)
        elif (ids := provider_models(provider, key, base_url, timeout=timeout, request=request)) is None:
            return own_models(conn, name)
    except ModelListError as exc:
        return own_models(conn, name, str(exc), refused=exc.status in (401, 403))
    except Exception as exc:
        # By type only: a client's message could quote the request.
        log.warning("listing the models of connection %s failed (%s)", name, type(exc).__name__)
        return own_models(conn, name, "the listing failed")
    # The configured model answered when the connection was added, though a host may list only dated ids for an
    # alias, and _text_models may drop it.
    if (model := llm.get("model")) and model not in ids:
        ids = [model, *ids]
    return Listing(connection=name, models=[ModelOption(id=i) for i in ids], listed=True)


def list_models(conn: Provider, name: str, *, deadline: float = DEADLINE,
                request: Callable[..., HttpResponse] | None = None,
                transport: httpx.BaseTransport | None = None, auth_file: Path | None = None) -> Listing:
    """The models connection ``name`` (``conn``) offers, within ``deadline`` seconds.

    A subscription is listed through its sign-in at ``auth_file``; without one, it offers only its configured model.
    Azure is listed by its deployments, and any other provider by composer's listing of the host its runs go to,
    with the key they use (``request`` and ``transport`` stand in for the two HTTP clients); a listed connection
    offers its configured model first if its host doesn't list it. A connection whose provider has no listing,
    whose runs need a key it doesn't hold, or whose runs an environment variable sends to another host offers only
    its configured model. A listing that fails offers the same, with ``error`` giving the HTTP status or another
    reason, never the key.
    """
    done: list[Listing] = []
    worker = threading.Thread(target=lambda: done.append(_listed(conn, name, deadline, request, transport, auth_file)),
                              name=f"models-{name}", daemon=True)
    worker.start()
    # The clients' timeouts bound each step, not the whole listing; a reply trickling in could outlast them.
    worker.join(deadline)
    return done[0] if done else own_models(conn, name, TIMED_OUT)


Lister = Callable[..., ModelList]
"""``list_models``, or a stand-in with its ``(conn, name, *, deadline, auth_file)``."""


class ModelCache:
    """Each connection's listing, kept ``FRESH`` seconds, and made by one caller at a time per connection.

    One lock guards the entries and is held only to read or write them. Each connection has its own lock, held while
    it lists, so a slow connection never holds up another, and a caller that finds a listing under way waits for it
    rather than listing again. ``clock`` dates the entries.
    """

    def __init__(self, connections: Connections, *, lister: Lister = list_models,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.connections = connections
        self._lister = lister
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: dict[str, tuple[float, str, ModelList]] = {}
        self._listing: dict[str, threading.Lock] = {}

    def get(self, name: str, *, refresh: bool = False, deadline: float = DEADLINE) -> ModelList:
        """The models connection ``name`` offers, listed again if ``refresh``, if older than ``FRESH`` seconds, or
        if the last listing failed.

        Raises:
            BadConnectionName: ``name`` isn't a connection name.
            ConnectionGone: there is no such connection.
            ProviderError: its file can't be used.
        """
        end = time.monotonic() + deadline
        conn = self.connections.get(name)
        with self._lock:
            entry = self._entries.get(name)
        if (not refresh and entry is not None and entry[1] == config_hash(conn) and entry[2].error is None
                and self._clock() - entry[0] < FRESH):
            return entry[2]
        return self._list(name, conn, entry, end)

    def offers(self, names: Iterable[str], model: str, *, deadline: float) -> list[str]:
        """Those of ``names`` that offer ``model``, using any listing kept, however old, and listing the rest and those
        whose last listing failed.

        Raises:
            ListTimeout: ``deadline`` seconds passed before every connection was listed.
            BadConnectionName, ConnectionGone, ProviderError: as ``get``.
        """
        end = time.monotonic() + deadline
        found = []
        for name in names:
            conn = self.connections.get(name)
            with self._lock:
                entry = self._entries.get(name)
            # A listing that failed says nothing about the models, so it doesn't count as an answer.
            if entry is not None and entry[1] == config_hash(conn) and (entry[2].listed or entry[2].error is None):
                listed = entry[2]
            else:
                listed = self._list(name, conn, entry, end)
                # Composer says "timed out" in the same fixed words, so a host that times out counts as a timeout too.
                if listed.error == TIMED_OUT:
                    raise ListTimeout(f"listing the models of connection '{name}' took too long")
            if any(m.id == model for m in listed.models):
                found.append(name)
        return found

    def invalidate(self, name: str | None = None) -> None:
        """Forget the listing of connection ``name``, or of every connection."""
        with self._lock:
            if name is None:
                self._entries.clear()
            else:
                self._entries.pop(name, None)

    def warm(self) -> threading.Thread:
        """Start listing, in the background, every connection not listed in the last ``FRESH`` seconds.

        Returns at once with the thread that does it, which ends once every connection is listed.
        """
        thread = threading.Thread(target=self._warm, name="models-warm", daemon=True)
        thread.start()
        return thread

    def _warm(self) -> None:
        try:
            names = self.connections.names()
        except ProviderError:
            log.warning("the office's connections can't be read; no models are listed ahead of time")
            return
        threads = [threading.Thread(target=self._warm_one, args=(name,), name=f"models-warm-{name}", daemon=True)
                   for name in names]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

    def _warm_one(self, name: str) -> None:
        try:
            self.get(name)
        except (ValueError, ProviderError):
            log.warning("connection %s can't be read; its models aren't listed ahead of time", name)

    def _list(self, name: str, conn: ConnectionFile, seen: tuple | None, end: float) -> ModelList:
        """List connection ``name``, unless another caller lists it while this one waits; ``seen`` is the entry this
        caller found, and ``end`` the ``time.monotonic()`` it must be done by."""
        with self._lock:
            lock = self._listing.setdefault(name, threading.Lock())
        if not lock.acquire(timeout=max(0.0, end - time.monotonic())):
            return own_models(conn, name, TIMED_OUT)
        try:
            with self._lock:
                entry = self._entries.get(name)
            if entry is not None and entry is not seen and entry[1] == config_hash(conn):
                return entry[2]  # listed while this caller waited
            remaining = end - time.monotonic()
            if remaining <= 0:
                return own_models(conn, name, TIMED_OUT)
            auth_file = self.connections.auth_file(name) if conn.method == "subscription" else None
            listed = self._lister(conn, name, deadline=remaining, auth_file=auth_file)
            with self._lock:
                self._entries[name] = (self._clock(), config_hash(conn), listed)
            return listed
        finally:
            lock.release()

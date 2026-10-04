"""This office's model connections: office/provider.json (``office``) and office/connections/<name>.json."""

import hashlib
import itertools
import json
import os
import re
import threading
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import TypeAdapter, model_validator

from agent_corp.chat.provider import Provider, ProviderError, load_provider
from agent_corp.protocol import models
from agent_corp.secrets import write_private

OFFICE = "office"
"""The connection that is office/provider.json, set up by ``ac onboard``."""

RESERVED = {OFFICE, "default", "login"}
"""Names no added connection may take: ``default`` and ``login`` are routes under /connections."""

NAME = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$")

AUTH_FILE_ENV = "AGENT_COMPOSER_AUTH_FILE"
"""The variable that points composer at a subscription's own auth store."""


class ConnectionGone(ProviderError):
    """A connection is no longer on this office."""


class RunMoved(ProviderError):
    """A run's connection is gone, or no longer gives the endpoint, key or config the run had."""


class ConnectionFile(Provider):
    """A connection file: a ``Provider`` plus how it signs in."""

    method: Literal["api_key", "subscription"] = "api_key"

    @model_validator(mode="after")
    def _subscription_has_no_key(self) -> "ConnectionFile":
        # A key would make composer bill it instead of the subscription.
        llm = self.llm_config or {}
        if self.method == "subscription" and (llm.get("provider") != "openai" or "api_key" in llm):
            raise ValueError("a subscription connection is provider openai with no api_key")
        return self


@dataclass(frozen=True)
class RunRecord:
    """What a run was started on: its connection and model, and hashes of what they gave it."""

    connection: str
    model: str | None
    config: str
    """For resume: the whole config without its key, plus the key's sha256."""
    target: str
    """For backward: provider, base_url, env, and the key's sha256."""


_RUN_RECORD = TypeAdapter(RunRecord)


def _check(name: str) -> None:
    """Raise ValueError unless ``name`` may name an added connection."""
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise ValueError(f"a connection name must match {NAME.pattern}")
    if name in RESERVED:
        raise ValueError(f"{name!r} is reserved" + (" for office/provider.json" if name == OFFICE else ""))


class Connections:
    """Reads, writes and resolves the office's connections; every file 0600, the directory 0700.

    Hold ``lock`` around ``free_name`` and the ``put`` that takes the name, so two adds can't take the same name;
    ``remove`` takes it itself.
    """

    def __init__(self, office: Path) -> None:
        self.office = office
        self.dir = office / "connections"
        self.lock = threading.Lock()

    def names(self) -> list[str]:
        """``office`` first, then the added connections, sorted."""
        try:
            stems = [p.name.removesuffix(".json") for p in self.dir.iterdir() if p.name.endswith(".json")]
        except FileNotFoundError:
            stems = []
        removed = self._removed()
        return [OFFICE] + sorted(s for s in stems
                                 if NAME.fullmatch(s) and s not in RESERVED and s not in removed)

    def get(self, name: str) -> ConnectionFile:
        """Connection ``name``, key included.

        Raises:
            ValueError: ``name`` isn't a connection name.
            ConnectionGone: there is no such connection, or it was removed.
            ProviderError: its file can't be used.
        """
        if name == OFFICE:
            # Read as a plain Provider, so provider.json is checked exactly as before connections.
            return ConnectionFile(**dict(load_provider(self.office / "provider.json")))
        path = self._path(name)
        if name in self._removed():
            raise ConnectionGone(f"connection '{name}' was removed")
        if not os.path.lexists(path):
            raise ConnectionGone(f"there is no connection '{name}' on this office")
        return load_provider(path, model=ConnectionFile)

    def info(self, name: str) -> models.Connection:
        """Connection ``name`` as clients see it, without its key."""
        conn = self.get(name)
        llm = conn.llm_config or {}
        if name == OFFICE:
            method = "api_key" if "api_key" in llm else "none"  # without a key, composer's own login
        else:
            method = conn.method
        label = "chatgpt" if conn.method == "subscription" else provider_label(llm)
        return models.Connection(name=name, provider=label, method=method, model=llm.get("model"),
                                 default=name == self.default())

    def default(self) -> str:
        """The connection new chats start on: the one ``_default.json`` names, or ``office`` if it is gone."""
        try:
            name = json.loads((self.dir / "_default.json").read_bytes())["name"]
        except (OSError, ValueError, LookupError, TypeError):
            return OFFICE
        return name if isinstance(name, str) and name in self.names() else OFFICE

    def set_default(self, name: str) -> None:
        """Make ``name`` the default; ConnectionGone if there is no such connection."""
        if name != OFFICE:
            _check(name)
            if name not in self.names():
                raise ConnectionGone(f"there is no connection '{name}' on this office")
        self.ensure_dir()
        write_private(self.dir / "_default.json", json.dumps({"name": name}).encode())

    def ensure_dir(self) -> Path:
        """office/connections, made 0700 (composer's auth store refuses any other mode)."""
        self.dir.mkdir(mode=0o700, exist_ok=True)
        self.dir.chmod(0o700)  # the umask may have narrowed it, or it was made by hand
        return self.dir

    def put(self, name: str, conn: ConnectionFile) -> None:
        """Write connection ``name``; a removed name is refused."""
        path = self._path(name)
        if name in self._removed():
            raise ValueError(f"connection name '{name}' was removed and is never used again")
        self.ensure_dir()
        write_private(path, conn.model_dump_json(indent=2).encode())

    def remove(self, name: str) -> None:
        """Remove connection ``name`` and its sign-in; ValueError for ``office``, ConnectionGone if absent."""
        if name == OFFICE:
            raise ValueError("office is office/provider.json; `ac onboard` changes it, and it can't be removed")
        path = self._path(name)
        with self.lock:
            if name not in self.names():
                raise ConnectionGone(f"there is no connection '{name}' on this office")
            # The name is retired before its files go: a connection re-added under it would move that name's
            # chats and runs to a new account without a word, and a remove cut short still reads as removed.
            self.ensure_dir()
            removed = sorted(self._removed() | {name})
            write_private(self.dir / "_removed.json", json.dumps({"names": removed}).encode())
            auth = self.auth_file(name)
            for p in (path, auth, auth.with_name(auth.name + ".lock")):  # composer locks its store with the .lock
                p.unlink(missing_ok=True)

    def free_name(self, base: str) -> str:
        """``base``, or ``base-2``, ``base-3``, …: the first that no file, reservation or removal holds."""
        removed = self._removed()
        for n in itertools.count(1):
            name = base if n == 1 else f"{base}-{n}"
            if not NAME.fullmatch(name):
                raise ValueError(f"a connection name must match {NAME.pattern}")
            if name in RESERVED or name in removed:
                continue
            if not os.path.lexists(self._path(name)) and not os.path.lexists(self.auth_file(name)):
                return name
        raise AssertionError("unreachable")

    def auth_file(self, name: str) -> Path:
        """Where subscription ``name`` keeps its sign-in (composer's own auth store)."""
        _check(name)
        return self.dir / f"{name}.auth.json"

    def resolve(self, name: str | None, model: str | None) -> Provider:
        """What a run on connection ``name`` (None: ``office``) and ``model`` (None: the connection's own) gets.

        Raises:
            ValueError: ``name`` isn't a connection name.
            ConnectionGone: there is no such connection, or it was removed.
            ProviderError: its file can't be used, or a subscription has no sign-in.
        """
        name = OFFICE if name is None else name
        conn = self.get(name)
        llm = conn.llm_config
        if model:
            llm = {**(llm or {}), "model": model}  # for Azure, the deployment name
        env = dict(conn.env)
        if conn.method == "subscription":
            auth = self.auth_file(name)
            if not auth.is_file():
                # Without its store, composer would fall back to no credentials at all.
                raise ProviderError(f"connection '{name}' has no sign-in; remove it and connect again")
            env[AUTH_FILE_ENV] = str(auth)
        return Provider(llm_config=llm, env=env, prices=conn.prices)

    def for_run(self, record: RunRecord | None, log: Path, *, exact: bool) -> Provider:
        """The provider to resume (``exact``) or learn from (not ``exact``) the run with ``record`` and ``log``.

        A run with no record is from before records, when every run was on ``office``: it counts as ``office``
        only if every base_url its log recorded is office's current one.

        Raises:
            RunMoved: the run's connection is gone or no longer gives what the run had; the message says why.
            ProviderError: the connection's file can't be used.
        """
        run = log.name.removesuffix(".jsonl")
        if record is None:
            office = self.resolve(OFFICE, None)
            urls = recorded_base_urls(log)
            if urls is None:
                raise RunMoved(f"run {run} has no record and no readable log")
            if any(url != (office.llm_config or {}).get("base_url") for url in urls):
                raise RunMoved(f"run {run} has no record and ran on another endpoint")
            return office
        try:
            provider = self.resolve(record.connection, record.model)
        except ConnectionGone:
            raise RunMoved(f"connection '{record.connection}' was removed") from None
        if exact and config_hash(provider) != record.config:
            raise RunMoved(f"connection '{record.connection}' changed since run {run}")
        if not exact and target_hash(provider) != record.target:
            raise RunMoved(f"connection '{record.connection}' changed (endpoint or key) since run {run}")
        return provider

    def _path(self, name: str) -> Path:
        _check(name)
        return self.dir / f"{name}.json"

    def _removed(self) -> set[str]:
        """The names of removed connections, which are never used again."""
        path = self.dir / "_removed.json"
        try:
            names = json.loads(path.read_bytes())["names"]
        except FileNotFoundError:
            return set()
        except (OSError, ValueError, LookupError, TypeError):
            names = None
        if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
            # Reading a garbled list as empty would let a removed name come back.
            raise ProviderError(f"{path} can't be read")
        return set(names)


def key_id(provider: Provider) -> str | None:
    """The sha256 hex of the provider's key, as composer identifies keys; None without one."""
    key = (provider.llm_config or {}).get("api_key")
    return hashlib.sha256(key.encode("utf-8")).hexdigest() if isinstance(key, str) else None


def _hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def config_hash(provider: Provider) -> str:
    """A hash of everything a run gets from ``provider``: its config without the key, env, and the key's hash."""
    llm = provider.llm_config
    if llm is not None:
        llm = {k: v for k, v in llm.items() if k != "api_key"}
    return _hash({"llm_config": llm, "env": provider.env, "key": key_id(provider)})


def target_hash(provider: Provider) -> str:
    """A hash of where ``provider`` sends a run and as whom: provider, base_url, env, and the key's hash."""
    llm = provider.llm_config or {}
    return _hash({"provider": llm.get("provider"), "base_url": llm.get("base_url"), "env": provider.env,
                  "key": key_id(provider)})


def write_run_record(path: Path, connection: str, model: str | None, provider: Provider) -> None:
    """Record at ``path`` that a run starts on ``connection`` and ``model``, which give it ``provider``."""
    record = RunRecord(connection, model, config_hash(provider), target_hash(provider))
    path.parent.mkdir(parents=True, exist_ok=True)
    write_private(path, json.dumps(asdict(record)).encode())


def read_run_record(path: Path) -> RunRecord | None:
    """The run record at ``path``; None when there is none (a run from before records).

    Raises:
        ValueError: the record can't be read.
    """
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ValueError(f"can't read {path}: {exc.strerror}") from None
    return _RUN_RECORD.validate_json(data)


def recorded_base_urls(log: Path) -> set[str | None] | None:
    """Each base_url (None: none) on the run_started record that opens run log ``log``; None if it can't be read."""
    try:
        with log.open("rb") as f:
            first = json.loads(f.readline())
        if first["kind"] != "run_started":
            return None
        return {config.get("base_url") for config in first["payload"]["effective_llm_by_static_path"].values()}
    except (OSError, ValueError, LookupError, TypeError, AttributeError):
        return None


def provider_label(llm: dict | None) -> str:
    """A short name for the provider of ``llm``: ``azure``, ``custom`` (another OpenAI-compatible endpoint), the
    provider's own name, or ``composer`` for composer's default provider."""
    llm = llm or {}
    provider = llm.get("provider")
    if not provider:
        return "composer"
    if provider == "openai" and llm.get("base_url"):
        host = urlsplit(llm["base_url"]).hostname or ""
        return "azure" if host.endswith(".azure.com") else "custom"
    return provider


def azure_base_url(answer: str) -> str:
    """The v1 endpoint of an Azure OpenAI resource given by its name or its endpoint URL."""
    url = answer.strip().rstrip("/").removesuffix("/openai/v1")
    if "://" not in url:
        url = f"https://{url}" if "." in url else f"https://{url}.openai.azure.com"
    return f"{url}/openai/v1/"

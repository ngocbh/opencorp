"""This office's model connections: office/provider.json (``office``) and office/connections/<name>.json."""

import fcntl
import hashlib
import itertools
import json
import logging
import os
import re
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from agent_composer.llm_clients.connection import _API_ENDPOINT
from pydantic import BaseModel, ConfigDict, field_validator, model_validator

from agent_corp.chat.provider import Provider, ProviderError, load_provider, read_private
from agent_corp.protocol import models
from agent_corp.secrets import write_private

log = logging.getLogger(__name__)

OFFICE = "office"
"""The connection that is office/provider.json, set up by ``ac onboard``."""

RESERVED = {OFFICE, "default", "login"}
"""Names no added connection may take: ``default`` and ``login`` are routes under /connections."""

NAME = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$")

AUTH_FILE_ENV = "AGENT_COMPOSER_AUTH_FILE"
"""The variable that points composer at a subscription's own auth store."""

SIGN_IN_LOCK_TIMEOUT = 30.0
"""Seconds ``remove`` waits for composer's lock on a sign-in; composer's own store waits as long."""


class ConnectionGone(ProviderError):
    """A connection is no longer on this office."""


class RunMoved(ProviderError):
    """A run's connection is gone, or no longer gives the endpoint, key or config the run had."""


class ConnectionFile(Provider):
    """A connection file: a ``Provider`` plus how it signs in."""

    method: Literal["api_key", "subscription"] = "api_key"

    @field_validator("env")
    @classmethod
    def _no_auth_file(cls, env: dict[str, str]) -> dict[str, str]:
        # The office sets it to the connection's own sign-in; one in the file could point at another account's.
        if AUTH_FILE_ENV in env:
            raise ValueError(f"{AUTH_FILE_ENV} is set by the office, not the connection")
        return env

    @model_validator(mode="after")
    def _subscription_has_no_key(self) -> "ConnectionFile":
        # A key would make composer bill it instead of the subscription.
        llm = self.llm_config or {}
        if self.method == "subscription" and (llm.get("provider") != "openai" or "api_key" in llm):
            raise ValueError("a subscription connection is provider openai with no api_key")
        return self


class RunRecord(BaseModel):
    """What a run was started on: its connection and model, and hashes of what they gave it."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    connection: str
    model: str | None
    config: str
    """For resume: the whole config without its key, plus the key's sha256."""
    target: str
    """For backward: provider, base_url, env, and the key's sha256."""


def _check(name: str) -> None:
    """Raise ValueError unless ``name`` may name an added connection."""
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise ValueError(f"a connection name must match {NAME.pattern}")
    if name in RESERVED:
        raise ValueError(f"{name!r} is reserved" + (" for office/provider.json" if name == OFFICE else ""))


class Connections:
    """Reads, writes and resolves the office's connections; every file 0600, the directory 0700.

    Writes are serialised within the office, so two adds never take the same name and two writes of one file
    never share ``write_private``'s temporary file.
    """

    def __init__(self, office: Path) -> None:
        self.office = office
        self.dir = office / "connections"
        self._lock = threading.RLock()

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
        _check(name)
        if name in self._removed():
            raise ConnectionGone(f"connection '{name}' was removed")
        return self._load(name)

    def info(self, name: str) -> models.Connection:
        """Connection ``name`` as clients see it, without its key."""
        return self._info(name, self.get(name), self.default())

    def infos(self) -> tuple[list[models.Connection], str]:
        """Every connection as clients see it, and the default; one that can't be read is left out."""
        names = self.names()
        default = self._default(names)
        found = []
        for name in names:  # names() has left out the removed ones
            try:
                found.append(self._info(name, self.get(OFFICE) if name == OFFICE else self._load(name), default))
            except (ValueError, ProviderError):
                log.warning("connection %s can't be read; leaving it out of the list", name)
        return found, default

    def default(self) -> str:
        """The connection new chats start on: the one ``_default.json`` names, or ``office`` if it is gone.

        Raises:
            ProviderError: ``_default.json`` isn't a private regular file, or isn't a default.
        """
        return self._default(self.names())

    def set_default(self, name: str) -> None:
        """Make ``name`` the default; ConnectionGone if there is no such connection."""
        if name != OFFICE:
            _check(name)
        with self._lock:
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
        with self._lock:
            if name in self._removed():
                raise ValueError(f"connection name '{name}' was removed and is never used again")
            self.ensure_dir()
            write_private(path, conn.model_dump_json(indent=2).encode())

    def add(self, base: str, conn: ConnectionFile, *, sign_in: Callable[[Path], None] | None = None) -> str:
        """Add ``conn`` under the first free name of ``base``, ``base-2``, …, and return that name.

        ``sign_in``, when given, saves the connection's sign-in to the path it is passed before the connection file
        is written; if either fails, the sign-in is removed again.
        """
        with self._lock:
            name = self._free_name(base)
            self.ensure_dir()
            auth = self.auth_file(name)
            try:
                if sign_in is not None:
                    sign_in(auth)
                self.put(name, conn)
            except BaseException:
                if sign_in is not None:
                    _remove_sign_in(auth)
                raise
            return name

    def remove(self, name: str) -> None:
        """Remove connection ``name`` and its sign-in; ValueError for ``office``, ConnectionGone if neither exists.

        A running reply keeps the key it has. Raises ProviderError if composer holds the sign-in's lock for longer
        than ``SIGN_IN_LOCK_TIMEOUT``.
        """
        if name == OFFICE:
            raise ValueError("office is office/provider.json; `ac onboard` changes it, and it can't be removed")
        path = self._path(name)
        auth = self.auth_file(name)
        with self._lock:
            if name not in self.names() and not os.path.lexists(auth):
                raise ConnectionGone(f"there is no connection '{name}' on this office")
            # The name is retired before its files go: a connection re-added under it would move that name's
            # chats and runs to a new account without a word, and a remove cut short still reads as removed.
            removed = self._removed()
            if name not in removed:
                self.ensure_dir()
                write_private(self.dir / "_removed.json", json.dumps({"names": sorted(removed | {name})}).encode())
            path.unlink(missing_ok=True)
            _remove_sign_in(auth)

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
        only if every model its log pinned has office's provider and endpoint.

        Raises:
            RunMoved: the run's connection is gone, can't be used, or no longer gives what the run had; the
                message says why.
        """
        run = log.name.removesuffix(".jsonl")
        if record is None:
            office = self._for_run(OFFICE, None)
            pinned = recorded_endpoints(log)
            if pinned is None:
                raise RunMoved(f"run {run} has no record and no readable log")
            # A run with no models has an empty set and matches: composer then drops the host key, so it goes
            # nowhere (agent_composer/run.py, "A key that marks no agent", and the same check on resume).
            expected = office_endpoint(office)
            if any(p != expected for p in pinned):
                raise RunMoved(f"run {run} has no record and ran on another provider or endpoint")
            return office
        if record.connection != OFFICE and (not NAME.fullmatch(record.connection) or record.connection in RESERVED):
            raise RunMoved(f"run {run}'s record names no connection")
        provider = self._for_run(record.connection, record.model)
        if exact and config_hash(provider) != record.config:
            raise RunMoved(f"connection '{record.connection}' changed since run {run}")
        if not exact and target_hash(provider) != record.target:
            raise RunMoved(f"connection '{record.connection}' changed (endpoint or key) since run {run}")
        return provider

    def _for_run(self, name: str, model: str | None) -> Provider:
        """``resolve(name, model)``, with each reason it can't be used as a RunMoved."""
        try:
            return self.resolve(name, model)
        except ConnectionGone:
            raise RunMoved(f"connection '{name}' was removed") from None
        except ProviderError as exc:
            raise RunMoved(str(exc)) from None

    def _load(self, name: str) -> ConnectionFile:
        """The file of added connection ``name``, removed or not; ConnectionGone if there is none."""
        try:
            # Not an exists-then-read: a remove between the two would read as an empty connection.
            return load_provider(self._path(name), model=ConnectionFile, missing_ok=False)
        except FileNotFoundError:
            raise ConnectionGone(f"there is no connection '{name}' on this office") from None

    def _info(self, name: str, conn: ConnectionFile, default: str) -> models.Connection:
        llm = conn.llm_config or {}
        if name == OFFICE:
            method = "api_key" if "api_key" in llm else "none"  # without a key, composer's own login
        else:
            method = conn.method
        label = "chatgpt" if conn.method == "subscription" else provider_label(llm)
        return models.Connection(name=name, provider=label, method=method, model=llm.get("model"),
                                 default=name == default)

    def _default(self, names: list[str]) -> str:
        path = self.dir / "_default.json"
        try:
            name = json.loads(read_private(path))["name"]
        except FileNotFoundError:
            return OFFICE
        except (ValueError, LookupError, TypeError):
            name = None
        if not isinstance(name, str):
            raise ProviderError(f"{path} isn't a default connection")
        return name if name in names else OFFICE

    def _free_name(self, base: str) -> str:
        """``base``, or ``base-2``, ``base-3``, …: the first that no file, reservation or removal holds."""
        removed = self._removed()
        for n in itertools.count(1):
            name = base if n == 1 else f"{base}-{n}"
            if not NAME.fullmatch(name):  # also ends the loop once the suffix makes the name too long
                raise ValueError(f"a connection name must match {NAME.pattern}")
            if name in RESERVED or name in removed:
                continue
            if not os.path.lexists(self._path(name)) and not os.path.lexists(self.auth_file(name)):
                return name

    def _path(self, name: str) -> Path:
        _check(name)
        return self.dir / f"{name}.json"

    def _removed(self) -> set[str]:
        """The names of removed connections, which are never used again."""
        path = self.dir / "_removed.json"
        try:
            names = json.loads(read_private(path))["names"]
        except FileNotFoundError:
            return set()
        except (ValueError, LookupError, TypeError):
            names = None
        if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
            # Reading a garbled list as empty would let a removed name come back.
            raise ProviderError(f"{path} can't be read")
        return set(names)


def _remove_sign_in(auth: Path) -> None:
    """Delete the sign-in at ``auth`` and its lock file, holding composer's lock on it while doing so."""
    lock = auth.with_name(auth.name + ".lock")
    if not os.path.lexists(auth) and not os.path.lexists(lock):
        return
    # Composer refreshes a sign-in under an flock on this file; deleting either file under a refresh could let
    # the refresh write the sign-in back.
    try:
        fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    except OSError as exc:
        raise ProviderError(f"can't open {lock}: {exc.strerror}") from None
    try:
        deadline = time.monotonic() + SIGN_IN_LOCK_TIMEOUT
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise ProviderError(f"timed out waiting for the lock on {auth}") from None
                time.sleep(0.1)
        auth.unlink(missing_ok=True)
        lock.unlink(missing_ok=True)
    finally:
        os.close(fd)


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
    record = RunRecord(connection=connection, model=model, config=config_hash(provider),
                       target=target_hash(provider))
    path.parent.mkdir(parents=True, exist_ok=True)
    write_private(path, record.model_dump_json().encode())


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
    return RunRecord.model_validate_json(data)


def _endpoint(provider: Any, url: Any) -> tuple[Any, Any]:
    """``(provider, url)`` with an OpenAI model's unset endpoint as composer's, and no trailing slash."""
    if provider == "openai" and not url:
        url = _API_ENDPOINT  # what composer pins an OpenAI model to when nothing else gives an endpoint
    return provider, url.rstrip("/") if isinstance(url, str) else url


def recorded_endpoints(log: Path) -> set[tuple[Any, Any]] | None:
    """Each ``(provider, endpoint)`` the run_started record opening run log ``log`` pinned a model to (endpoint
    None: the provider's own); None if it can't be read.

    The endpoint is a model's ``base_url``, else its OpenAI connection's ``endpoint``, which composer replays on
    resume even if the environment that gave it has changed.
    """
    try:
        with log.open("rb") as f:
            first = json.loads(f.readline())
        if first["kind"] != "run_started":
            return None
        pinned = set()
        for config in first["payload"]["effective_llm_by_static_path"].values():
            url = config.get("base_url") or (config.get("_connection") or {}).get("endpoint")
            pinned.add(_endpoint(config.get("provider"), url))
        return pinned
    except (OSError, ValueError, LookupError, TypeError, AttributeError):
        return None


def office_endpoint(provider: Provider) -> tuple[Any, Any]:
    """The ``(provider, endpoint)`` a run on ``provider`` would pin its models to, as ``recorded_endpoints``
    gives them."""
    llm = provider.llm_config or {}
    url = llm.get("base_url")
    if llm.get("provider") == "openai" and not url:
        url = provider.env.get("OPENAI_BASE_URL")  # a worker's only environment is the provider's env
    return _endpoint(llm.get("provider"), url)


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

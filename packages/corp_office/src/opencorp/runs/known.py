"""The secret values the office holds that a run log may echo: read within a time limit, failing closed, and cached
until what they were read from changes."""

import asyncio
import json
import os
import threading
import time
from collections.abc import Callable, Hashable, Iterable
from pathlib import Path
from typing import Any

from opencorp.chat.connections import ConnectionGone, Connections
from opencorp.company.git import CompanyGit
from opencorp.company.loader import load_repo
from opencorp.company.secret_keys import MIN_KNOWN
from opencorp.company.source import person_secrets
from opencorp.runs.scrub import Scrubber, secret_key
from opencorp.secrets import SecretStore, read_private

LIMIT_S = 5.0
"""How long a request waits for the known values before it fails."""
TTL_S = 60.0
"""The longest a cached part is used, even when nothing it was read from looks changed."""
CACHED = 32
"""The most cached parts and Scrubbers kept; past that the cache starts over."""


class SecretsUnavailable(Exception):
    """The known secret values couldn't be read, or not in time: the request fails rather than show a page."""


def secret_strings(value: Any, *, under: bool = False) -> set[str]:
    """Every string of 8 or more characters under a secret-named key in ``value``, at any depth (``under``: ``value``
    is under one). Keys and other values (an account id, a timestamp) aren't secrets."""
    if isinstance(value, str):
        return {value} if under and len(value.strip()) >= MIN_KNOWN else set()
    if isinstance(value, dict):
        return set().union(*(secret_strings(v, under=under or secret_key(k)) for k, v in value.items()))
    if isinstance(value, list):
        return set().union(*(secret_strings(v, under=under) for v in value))
    return set()


def pin_values(secrets: SecretStore, git: CompanyGit, commit: str) -> set[str]:
    """The values of the asset secrets the company names at ``commit``. A secret that isn't set, or a name the store
    can't hold (so it can't have been echoed), is skipped."""
    found: set[str] = set()
    for asset in load_repo(git.pin(commit)).assets.values():
        for name in asset.secrets:
            try:
                found.add(secrets.get(name))
            except (KeyError, ValueError):
                continue
    return found


def office_values(connections: Connections, secrets: SecretStore, git: CompanyGit, head: str) -> set[str]:
    """Each connection's secrets (strings under secret-named keys of its llm_config: its key, an Azure token,
    credential headers; env holds none, Provider refuses credential names there), each sign-in file's tokens, the asset
    secrets named at ``head``, and #247's secrets in the person files at ``head``. A removed connection is skipped."""
    found: set[str] = set()
    for name in connections.names():
        try:
            found |= secret_strings(connections.get(name).llm_config or {})
        except ConnectionGone:
            continue
    for auth in sorted(connections.dir.glob("*.auth.json")):
        found |= secret_strings(json.loads(read_private(auth)))
    return found | pin_values(secrets, git, head) | set(person_secrets(git, git.list_tree(head)))


def _stamp(path: Path) -> tuple[int, int, int] | None:
    """What says ``path`` changed: a file written by rename gets a new inode; a folder's mtime moves when one does."""
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return None
    return st.st_ino, st.st_mtime_ns, st.st_size


class KnownValues:
    """The office's known secret values, as Scrubbers.

    Two kinds of part are cached:
    - the office's part (connections, sign-ins, HEAD's asset secrets and person files), keyed by HEAD and the stamps of
      provider.json, each connections/*.json file and the secrets folder;
    - each pin's asset secrets, keyed by pin and the secrets folder's stamp.

    Each part is used at most TTL_S. A build that misses the time limit still fills the cache when it ends.
    """

    def __init__(self, *, connections: Connections, secrets: SecretStore, git: CompanyGit, limit: float = LIMIT_S,
                 ttl: float = TTL_S, clock: Callable[[], float] = time.monotonic) -> None:
        self.connections, self.secrets, self.git = connections, secrets, git
        self.limit, self.ttl, self.clock = limit, ttl, clock
        self._parts: dict[Hashable, tuple[float, frozenset[str]]] = {}
        self._scrubbers: dict[frozenset[str], Scrubber] = {}
        self._lock = threading.Lock()

    async def scrubber(self, pins: Iterable[str] = ()) -> Scrubber:
        """A Scrubber with the known values of now, at HEAD and at each of ``pins``; SecretsUnavailable if they can't
        be read within ``limit`` seconds."""
        try:
            values = await asyncio.wait_for(asyncio.to_thread(self.values, list(pins)), self.limit)
        except TimeoutError:
            raise SecretsUnavailable("couldn't load the secrets to remove in time") from None
        with self._lock:
            found = self._scrubbers.get(values)
            if found is None:
                if len(self._scrubbers) >= CACHED:
                    self._scrubbers.clear()
                found = self._scrubbers[values] = Scrubber(values)
        return found

    def values(self, pins: list[str]) -> frozenset[str]:
        """The known values (blocking); SecretsUnavailable when any can't be read."""
        try:
            head = self.git.read_head()
            vault = _stamp(self.secrets.root)
            files = tuple((p.name, _stamp(p)) for p in sorted(self.connections.dir.glob("*.json")))
            office_key = ("office", head, _stamp(self.connections.office / "provider.json"), files, vault)
            parts = [self._part(office_key, lambda: office_values(self.connections, self.secrets, self.git, head))]
            for pin in dict.fromkeys(pins):
                if pin != head:
                    parts.append(self._part(("pin", pin, vault), lambda p=pin: pin_values(self.secrets, self.git, p)))
        except Exception as exc:  # whatever stops them being read: fail closed, as a 503, never a 500
            raise SecretsUnavailable(f"couldn't read the secrets to remove ({type(exc).__name__})") from None
        return frozenset(v for part in parts for v in part if len(v.strip()) >= MIN_KNOWN)

    def _part(self, key: Hashable, build: Callable[[], set[str]]) -> frozenset[str]:
        at = self.clock()
        with self._lock:
            hit = self._parts.get(key)
        if hit is not None and at - hit[0] < self.ttl:
            return hit[1]
        found = frozenset(build())
        with self._lock:
            if len(self._parts) >= CACHED:
                self._parts.clear()
            self._parts[key] = (at, found)
        return found

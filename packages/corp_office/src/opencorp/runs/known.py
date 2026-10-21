"""The secret values the office holds that a run log may echo: read within a time limit, one read at a time, failing
closed, and cached until a file they came from changes."""

import asyncio
import json
import os
import threading
from collections.abc import Callable, Hashable, Iterable, Mapping
from pathlib import Path
from typing import Any

from opencorp.chat.connections import AUTH_FILE_ENV, ConnectionGone, Connections
from opencorp.company.git import CompanyGit
from opencorp.company.secret_keys import MIN_KNOWN
from opencorp.company.source import person_secrets
from opencorp.runs.scrub import Scrubber, secret_key
from opencorp.secrets import SecretStore, Stamp, read_private, stamp

LIMIT_S = 5.0
"""How long a request waits for the known values before it fails."""
CACHED = 32
"""The most Scrubbers kept; past that the cache starts over."""


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


def store_values(secrets: SecretStore) -> set[str]:
    """Every secret in the office's store, whatever names it: one named only by an asset file that no longer loads,
    or by none now, may still have been given to a tool. A secret removed meanwhile is skipped; one that can't be read
    (not private, too short) raises, as it would for the monitor."""
    found: set[str] = set()
    for name in secrets.names():
        try:
            found.add(secrets.get(name))
        except KeyError:
            continue
    return found


def yian_auth_stores() -> list[Path]:
    """Where Yian's ``AuthStore`` keeps logins when no ``YIAN_AUTH_FILE`` is set: under ``~/.config``, as a worker
    (which inherits HOME but not XDG_CONFIG_HOME) finds it, and under the office's ``XDG_CONFIG_HOME`` when set."""
    found = [Path.home() / ".config" / "yian" / "auth.json"]
    if xdg := os.environ.get("XDG_CONFIG_HOME"):
        found.append(Path(xdg) / "yian" / "auth.json")
    return list(dict.fromkeys(found))


def env_auth_stores(env: Mapping[str, str]) -> list[Path]:
    """The Yian stores a connection's ``env`` can point a worker at: its ``YIAN_AUTH_FILE``, and the default store
    under its ``XDG_CONFIG_HOME`` or ``HOME``. ValueError for a relative path, which turns on the worker's folder, so
    the office can't tell which store it names."""
    found = []
    if path := env.get(AUTH_FILE_ENV):
        found.append(Path(path).expanduser())
    if xdg := env.get("XDG_CONFIG_HOME"):
        found.append(Path(xdg).expanduser() / "yian" / "auth.json")
    if home := env.get("HOME"):
        found.append(Path(home).expanduser() / ".config" / "yian" / "auth.json")
    if relative := [str(p) for p in found if not p.is_absolute()]:
        raise ValueError(f"a connection's env names a Yian store by a relative path: {relative[0]}")
    return found


def connection_values(connections: Connections) -> tuple[set[str], list[Path]]:
    """Each connection's secrets (strings under secret-named keys of its llm_config: its key, an Azure token,
    credential headers; env holds none, Provider refuses credential names there) and the tokens and keys in each
    sign-in file; and the Yian stores the connections' env names. A removed connection is skipped."""
    found: set[str] = set()
    stores: list[Path] = []
    for name in connections.names():
        try:
            conn = connections.get(name)
        except ConnectionGone:
            continue
        found |= secret_strings(conn.llm_config or {})
        stores += env_auth_stores(conn.env)
    for auth in sorted(connections.dir.glob("*.auth.json")):
        found |= secret_strings(json.loads(read_private(auth)))
    return found, stores


def yian_values(stores: Iterable[Path]) -> set[str]:
    """The tokens and keys in each of the Yian ``stores`` that exists."""
    found: set[str] = set()
    for store in stores:
        try:
            found |= secret_strings(json.loads(read_private(store)))
        except FileNotFoundError:
            continue
    return found


def office_values(connections: Connections, secrets: SecretStore) -> set[str]:
    """The connections' secrets and sign-ins (``connection_values``), the logins in Yian's default stores and in any
    store a connection's env names, and every secret in the office's store."""
    found, stores = connection_values(connections)
    return found | yian_values(dict.fromkeys(yian_auth_stores() + stores)) | store_values(secrets)


def _stamp(path: Path) -> Stamp | None:
    try:
        return stamp(os.stat(path, follow_symlinks=False))
    except FileNotFoundError:
        return None


def _folder_stamps(folder: Path) -> tuple[Stamp | None, tuple[tuple[str, Stamp | None], ...]]:
    """``folder``'s stamp and each entry's, by name."""
    try:
        names = sorted(os.listdir(folder))
    except FileNotFoundError:
        return None, ()
    return _stamp(folder), tuple((name, _stamp(folder / name)) for name in names)


class KnownValues:
    """The office's known secret values, as Scrubbers.

    The values come in parts, each cached by the stamps (device, inode, size, mtime, ctime, mode, owner) of every file
    and folder it was read from, so a change counts at once, even a hand edit in place, which moves the ctime:
    - the connections and sign-ins: provider.json, the connections folder and each file in it (``_removed.json``,
      each connection and ``.auth.json``);
    - the Yian stores: the default ones and those the connections' env names;
    - the office's secret store: its folder and each secret file;
    - #247's secrets in the person files, by HEAD.
    A Scrubber, whose needles cost the most to build, is cached for each set of values.

    One read runs at a time. A request uses a read that began after it came, waiting first for one already running,
    so a read that hangs past the limit holds one thread, not one per request.
    """

    def __init__(self, *, connections: Connections, secrets: SecretStore, git: CompanyGit,
                 limit: float = LIMIT_S) -> None:
        self.connections, self.secrets, self.git, self.limit = connections, secrets, git, limit
        self._parts: dict[str, tuple[Hashable, Any]] = {}
        self._scrubbers: dict[frozenset[str], Scrubber] = {}
        self._lock = threading.Lock()
        self._read: asyncio.Future[frozenset[str]] | None = None
        self._read_no = 0
        self._reads = 0

    async def scrubber(self) -> Scrubber:
        """A Scrubber with the known values of now; SecretsUnavailable if they can't be read within ``limit``
        seconds."""
        try:
            async with asyncio.timeout(self.limit):
                values = await self._fresh()
        except TimeoutError:
            raise SecretsUnavailable("couldn't load the secrets to remove in time") from None
        with self._lock:
            found = self._scrubbers.get(values)
            if found is None:
                if len(self._scrubbers) >= CACHED:
                    self._scrubbers.clear()
                found = self._scrubbers[values] = Scrubber(values)
        return found

    async def _fresh(self) -> frozenset[str]:
        """The values from a read that began after this call."""
        came = self._reads
        while True:
            read = self._read
            if read is not None and self._read_no > came:
                return await asyncio.shield(read)  # one caller giving up mustn't cancel the others' read
            if read is not None and not read.done():
                await asyncio.wait([read])
                continue
            self._reads += 1
            self._read_no = self._reads
            self._read = asyncio.ensure_future(asyncio.to_thread(self.values))
            # Marks its failure seen, for a read every caller gave up on.
            self._read.add_done_callback(lambda f: f.cancelled() or f.exception())

    def values(self) -> frozenset[str]:
        """The known values (blocking); SecretsUnavailable when any can't be read."""
        try:
            head = self.git.read_head()
            office = self.connections.office / "provider.json"
            # Every stamp is taken before what it covers is read, so a change while reading shows next time.
            found, stores = self._part("connections", (_stamp(office), _folder_stamps(self.connections.dir)),
                                       lambda: connection_values(self.connections))
            stores = list(dict.fromkeys(yian_auth_stores() + stores))
            found = found | self._part("yian", tuple((p, _stamp(p)) for p in stores), lambda: yian_values(stores))
            found |= self._part("store", self.secrets.stamps(), lambda: store_values(self.secrets))
            found |= self._part("people", head, lambda: person_secrets(self.git, self.git.list_tree(head)))
        except Exception as exc:  # whatever stops them being read: fail closed, as a 503, never a 500
            raise SecretsUnavailable(f"couldn't read the secrets to remove ({type(exc).__name__})") from None
        return frozenset(v for v in found if len(v.strip()) >= MIN_KNOWN)

    def _part[T](self, name: str, key: Hashable, build: Callable[[], T]) -> T:
        with self._lock:
            hit = self._parts.get(name)
        if hit is not None and hit[0] == key:
            return hit[1]
        found = build()
        with self._lock:
            self._parts[name] = (key, found)
        return found

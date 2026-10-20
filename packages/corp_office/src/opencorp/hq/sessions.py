"""Browser sessions on HQ: a session cookie with per-browser revocation. Office-local rows hold the sha256 of a
32-byte secret, last 30 days, and end when the person at HEAD stops being a human or their password changes."""

from __future__ import annotations

import asyncio
import hashlib
import secrets
import string
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import yaml
from pydantic import ValidationError

from opencorp.company.git import CompanyGit
from opencorp.company.snapshot import CompanySnapshots
from opencorp.daemon.bus import Subscription
from opencorp.daemon.http import HTTPError
from opencorp.protocol.models import BrowserSession, CompanyView, Person
from opencorp.store import HqSessionRecord, Store, new_id

TTL = timedelta(days=30)
"""A fixed lifetime: a session isn't extended by use."""

TOUCH_EVERY = timedelta(hours=1)
"""How often ``last_used_at`` is written at most."""

_NAME_CHARS = string.ascii_lowercase + string.digits


def stamp(at: datetime) -> str:
    """``at`` as a protocol Timestamp."""
    return at.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def password_fp(password_hash: str | None) -> str:
    """The first 16 hex of sha256 of the person's password hash (of "" without one)."""
    return hashlib.sha256((password_hash or "").encode()).hexdigest()[:16]


def _secret_sha256(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


@dataclass(frozen=True)
class Humans:
    """The humans' password fingerprints at one commit, and the handles whose ``person.yaml`` can't be read there."""

    fps: dict[str, str]
    unreadable: frozenset[str]


def password_fps(git: CompanyGit, sha: str) -> Humans:
    """The humans' password fingerprints at commit ``sha``, read from git objects in one batch.

    The company snapshot drops password hashes, since it goes to browsers, so they are read here.
    """
    blobs = {path.split("/")[1]: blob for path, blob in git.files("people", sha).items()
             if path.count("/") == 2 and path.endswith("/person.yaml")}
    data = git.read_blobs(list(blobs.values()))
    found: dict[str, str] = {}
    unreadable: set[str] = set()
    for handle, blob in blobs.items():
        try:
            person = Person.model_validate(yaml.safe_load(data.get(blob) or b""))
        except (ValidationError, yaml.YAMLError, UnicodeDecodeError, RecursionError):
            unreadable.add(handle)  # the snapshot reports the broken file
            continue
        if person.handle != handle:
            unreadable.add(handle)
        elif person.kind == "human":
            found[handle] = password_fp(person.password_hash)
    return Humans(found, frozenset(unreadable))


class _Fingerprints:
    """``password_fps`` by commit, loaded once however many checks ask at the same time; the last ``KEEP`` are
    kept."""

    KEEP = 4

    def __init__(self, git: CompanyGit) -> None:
        self.git = git
        self._loads: dict[str, asyncio.Future[Humans]] = {}

    async def at(self, sha: str) -> Humans:
        load = self._loads.get(sha)
        if load is None or (load.done() and (load.cancelled() or load.exception() is not None)):
            load = self._loads[sha] = asyncio.ensure_future(asyncio.to_thread(password_fps, self.git, sha))
            while len(self._loads) > self.KEEP:
                self._loads.pop(next(iter(self._loads)))
        # Shielded: one caller going away mustn't cancel the load the others wait on.
        return await asyncio.shield(load)


@dataclass(frozen=True)
class Who:
    """The session a request's cookie carries, and the company at HEAD it was checked against."""

    id: str
    person: str
    name: str
    view: CompanyView


@dataclass
class _Live:
    """What each frame of an open stream checks without a store read, and what a commit is checked against."""

    expires_at: str
    person: str
    password_fp: str
    revoked: bool = False
    streams: set[Subscription] = field(default_factory=set)


class BrowserSessions:
    """Issues, checks and revokes browser sessions. Use it on the office loop; store calls run in threads."""

    def __init__(self, store: Store, snapshots: CompanySnapshots, *,
                 clock: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self.store = store
        self.snapshots = snapshots
        self.clock = clock
        self._fingerprints = _Fingerprints(snapshots.git)
        self._live: dict[str, _Live] = {}

    async def _at_head(self) -> tuple[CompanyView | None, Humans]:
        """The company at HEAD and its humans' password fingerprints."""
        view = await self.snapshots.head()
        return view, (Humans({}, frozenset()) if view is None else await self._fingerprints.at(view.sha))

    async def issue(self, person: str, *, issued_by: str, label: str | None) -> tuple[BrowserSession, str]:
        """A new session for the human ``person``; returns it and the cookie value ``<id>.<secret>``.

        The name is made here (``web-<6 characters>``), so no name conflict can fail the request after a pairing
        code is spent.
        """
        _, humans = await self._at_head()
        fps = humans.fps
        if person not in fps:
            raise HTTPError(422, "not_a_human", f"@{person} isn't a human in the company at HEAD")
        secret = secrets.token_urlsafe(32)
        at = self.clock()
        record = HqSessionRecord(
            id=new_id(), person=person, name="web-" + "".join(secrets.choice(_NAME_CHARS) for _ in range(6)),
            label=label, secret_sha256=_secret_sha256(secret), password_fp=fps[person],
            issued_by=issued_by, via="pair", created_at=stamp(at), expires_at=stamp(at + TTL), last_used_at=None)
        await asyncio.to_thread(self.store.add_hq_session, record)
        self._live[record.id] = _Live(record.expires_at, person, record.password_fp)
        return record.public(), f"{record.id}.{secret}"

    async def check(self, cookie: str | None) -> Who | None:
        """The session ``cookie`` carries, if it's live and its person, at HEAD, is still a human with the same
        password; a session failing those checks is ended."""
        sid, _, secret = (cookie or "").partition(".")
        if not sid or not secret:
            return None
        at = self.clock()
        now = stamp(at)
        self._forget_expired(now)
        row = await asyncio.to_thread(self.store.hq_session_by_secret, _secret_sha256(secret), now)
        if row is None or row.id != sid:  # only a cookie that proves the secret gets past here
            return None
        view, humans = await self._at_head()
        if row.person in humans.unreadable:
            # A typo, or a field from a newer writer, isn't offboarding: refuse until the file reads again.
            return None
        if view is None or humans.fps.get(row.person) != row.password_fp:
            await self.revoke(sid)
            return None
        # A revoke that ran while this check read the row left a revoked entry here, which wins.
        live = self._live.setdefault(sid, _Live(row.expires_at, row.person, row.password_fp))
        if live.revoked:
            return None
        before = stamp(at - TOUCH_EVERY)
        if row.last_used_at is None or row.last_used_at < before:
            await asyncio.to_thread(self.store.touch_hq_session, sid, now, before=before)
        return Who(id=sid, person=row.person, name=row.name, view=view)

    async def revoke(self, sid: str) -> bool:
        """End session ``sid``: delete its row and close its open streams; whether it existed.

        A live session stays in memory as revoked until it would have expired, so a check that read its row just
        before the delete still refuses it. An unknown or expired id adds nothing.
        """
        row = await asyncio.to_thread(self.store.get_hq_session, sid)
        # Looked up after the read, and never replaced: a check may have made the entry meanwhile.
        live = self._live.get(sid)
        if live is None and row is not None and row.expires_at > stamp(self.clock()):
            live = self._live.setdefault(sid, _Live(row.expires_at, row.person, row.password_fp))
        if live is not None:
            live.revoked = True
        return await asyncio.to_thread(self.store.delete_hq_session, sid)

    def _forget_expired(self, now: str) -> None:
        """Drop the in-memory entries of sessions past their expiry that no stream holds, so ``_live`` stays bounded
        by the sessions of the last 30 days."""
        for sid in [k for k, v in self._live.items() if v.expires_at <= now and not v.streams]:
            del self._live[sid]

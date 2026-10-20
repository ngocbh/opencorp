"""Signing a browser in with a handle and password, checked against the person's hash at HEAD."""

from __future__ import annotations

import asyncio
import math
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field

from opencorp.auth.passwords import check_password
from opencorp.hq.sessions import BrowserSessions, password_fp


DUMMY_HASH = "$scrypt$ln=16,r=8,p=1$b3BlbmNvcnAgaHEgc2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
"""A hash no password matches, at the cost of a new one: checked when the handle has no password, so an unknown
handle takes as long as a wrong password."""

WINDOW_S = 15 * 60
"""How long a failure counts, the longest wait, and how long a pair is remembered after its last failure."""

LIMIT = 5
"""Failures within ``WINDOW_S`` that lock a pair."""

FIRST_WAIT_S = 60
"""The first lock's length; each lock after it doubles, up to ``WINDOW_S``."""

MAX_KEYS = 1000
"""The most pairs the throttle remembers."""

CHECKS = 2
"""The most password checks at a time: each holds about 64 MiB and a core for a tenth of a second."""

type Key = tuple[str, str]
"""(peer address, handle)."""


class BadCredentials(Exception):
    """The handle and password don't sign anyone in; which part was wrong is never said."""


class Busy(Exception):
    """``CHECKS`` password checks are running already; the caller tries again later instead of queueing."""


class Throttled(Exception):
    """Too many failed sign-ins for this peer and handle; ``retry_after`` is the wait in whole seconds, and ``first``
    whether this is the first refusal under this lock."""

    def __init__(self, retry_after: int, first: bool) -> None:
        super().__init__(f"retry after {retry_after} s")
        self.retry_after, self.first = retry_after, first


@dataclass
class _Tries:
    failures: deque[float] = field(default_factory=lambda: deque(maxlen=LIMIT))
    locks: int = 0
    until: float = 0.0


class Throttle:
    """Failed sign-ins per (peer, handle), in memory: ``LIMIT`` failures within ``WINDOW_S`` lock the pair for
    ``FIRST_WAIT_S``, and each failure after a lock locks it again for twice as long, up to ``WINDOW_S``.

    A pair is forgotten, locks and all, ``WINDOW_S`` after its last failure; at most ``MAX_KEYS`` are kept, the least
    recently failed unlocked pair going first, and a lock is never evicted.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self.clock = clock
        self._tries: dict[Key, _Tries] = {}  # in order of last failure, oldest first
        self._told: dict[Key | None, float] = {}  # the lock end each pair was last refused under, for logging it once

    def __len__(self) -> int:
        return len(self._tries)

    def wait(self, key: Key) -> int | None:
        """The seconds left on ``key``'s lock, or None when it isn't locked. A pair not remembered while every
        remembered pair is locked waits for the first lock to end: there's no room to count its failures."""
        now = self.clock()
        until = self._until(key, now)
        return None if until is None else math.ceil(until - now)

    def refuse(self, key: Key) -> tuple[int, bool] | None:
        """``wait(key)`` and whether this is the first refusal under that lock, or None when it isn't locked."""
        now = self.clock()
        until = self._until(key, now)
        if until is None:
            return None
        told = key if key in self._tries else None  # refusals for a full table share one entry, so this stays bounded
        first = until != self._told.get(told)
        self._told[told] = until
        return math.ceil(until - now), first

    def _until(self, key: Key, now: float) -> float | None:
        self._forget(now)
        tries = self._tries.get(key)
        if tries is not None:
            return None if tries.until <= now else tries.until
        if len(self._tries) >= MAX_KEYS and all(t.until > now for t in self._tries.values()):
            return min(t.until for t in self._tries.values())
        return None

    def failed(self, key: Key) -> None:
        """Count a failure for ``key``, locking it once there are ``LIMIT`` within ``WINDOW_S`` or it was locked
        before."""
        now = self.clock()
        self._forget(now)
        tries = self._tries.pop(key, None) or _Tries()
        self._tries[key] = tries
        tries.failures.append(now)
        if tries.locks or (len(tries.failures) == LIMIT and tries.failures[0] > now - WINDOW_S):
            tries.until = now + min(FIRST_WAIT_S * 2 ** tries.locks, WINDOW_S)
            tries.locks += 1
        if len(self._tries) > MAX_KEYS:
            # Evicting a lock would let anyone clear it by failing on enough other handles: the oldest unlocked pair
            # goes, which is this one when every other pair is locked.
            del self._tries[next(k for k, t in self._tries.items() if t.until <= now)]

    def succeeded(self, key: Key) -> None:
        """Forget ``key``'s failures."""
        self._tries.pop(key, None)

    def _forget(self, now: float) -> None:
        # A lock never outlasts its pair's entry: it ends at most WINDOW_S after the failure that set it.
        while self._tries:
            key, tries = next(iter(self._tries.items()))
            if tries.failures[-1] > now - WINDOW_S:
                break
            del self._tries[key]
        # A refusal is remembered only while its lock lasts: at most the locked pairs, and one for a full table.
        for key in [k for k, until in self._told.items() if until <= now]:
            del self._told[key]


class Logins:
    """Checks sign-in passwords for HQ. Use it on the office loop; password checks run in threads."""

    def __init__(self, sessions: BrowserSessions, *, clock: Callable[[], float] = time.monotonic) -> None:
        self.sessions = sessions
        self.throttle = Throttle(clock)
        self._checks = asyncio.Semaphore(CHECKS)

    async def check(self, peer: str, handle: str, password: str) -> str:
        """The fingerprint of the password hash ``password`` matches, ``handle``'s at HEAD; raises ``BadCredentials``
        unless ``handle`` is a human whose password it is, ``Throttled`` while ``(peer, handle)`` is locked, and
        ``Busy`` when ``CHECKS`` checks are running.

        Pairing never comes here, so no number of failures here can lock anyone out of ``opencorp pair``.
        """
        key = (peer, handle)
        if (refused := self.throttle.refuse(key)) is not None:
            raise Throttled(*refused)
        if self._checks.locked():  # never a queue without bound
            raise Busy
        await self._checks.acquire()  # free, just checked: returns at once
        try:
            # Read from git on every sign-in, not cached: every handle, known or not, pays the same read, so timing
            # doesn't tell them apart, and the semaphore bounds how many reads run at once.
            phc = await self.sessions.password_hash(handle)
        except BaseException:
            self._checks.release()
            raise
        # scrypt costs about 64 MiB and a tenth of a second: off the loop. The slot is freed when the check ends,
        # not when this request does, so clients that go away mid-check can't start more checks than CHECKS.
        check = asyncio.ensure_future(asyncio.to_thread(check_password, password, phc or DUMMY_HASH))
        check.add_done_callback(lambda _: self._checks.release())
        matched = await asyncio.shield(check)
        if phc is None or not matched:
            self.throttle.failed(key)
            raise BadCredentials
        self.throttle.succeeded(key)
        return password_fp(phc)

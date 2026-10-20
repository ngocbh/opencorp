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

type Key = tuple[str, str]
"""(peer address, handle)."""


class BadCredentials(Exception):
    """The handle and password don't sign anyone in; which part was wrong is never said."""


class Throttled(Exception):
    """Too many failed sign-ins for this peer and handle; ``retry_after`` is the wait in whole seconds."""

    def __init__(self, retry_after: int) -> None:
        super().__init__(f"retry after {retry_after} s")
        self.retry_after = retry_after


@dataclass
class _Tries:
    failures: deque[float] = field(default_factory=lambda: deque(maxlen=LIMIT))
    locks: int = 0
    until: float = 0.0


class Throttle:
    """Failed sign-ins per (peer, handle), in memory: ``LIMIT`` failures within ``WINDOW_S`` lock the pair for
    ``FIRST_WAIT_S``, and each failure after a lock locks it again for twice as long, up to ``WINDOW_S``.

    A pair is forgotten, locks and all, ``WINDOW_S`` after its last failure; at most ``MAX_KEYS`` are kept, the least
    recently failed going first.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self.clock = clock
        self._tries: dict[Key, _Tries] = {}  # in order of last failure, oldest first

    def __len__(self) -> int:
        return len(self._tries)

    def wait(self, key: Key) -> int | None:
        """The seconds left on ``key``'s lock, or None when it isn't locked."""
        now = self.clock()
        self._forget(now)
        tries = self._tries.get(key)
        return None if tries is None or tries.until <= now else math.ceil(tries.until - now)

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
        while len(self._tries) > MAX_KEYS:
            del self._tries[next(iter(self._tries))]

    def succeeded(self, key: Key) -> None:
        """Forget ``key``'s failures."""
        self._tries.pop(key, None)

    def _forget(self, now: float) -> None:
        # A lock never outlasts its pair's entry: it ends at most WINDOW_S after the failure that set it.
        while self._tries:
            key, tries = next(iter(self._tries.items()))
            if tries.failures[-1] > now - WINDOW_S:
                return
            del self._tries[key]


class Logins:
    """Checks sign-in passwords for HQ. Use it on the office loop; password checks run in threads."""

    def __init__(self, sessions: BrowserSessions, *, clock: Callable[[], float] = time.monotonic) -> None:
        self.sessions = sessions
        self.throttle = Throttle(clock)

    async def check(self, peer: str, handle: str, password: str) -> str:
        """The fingerprint of the password hash ``password`` matches, ``handle``'s at HEAD; raises ``BadCredentials``
        unless ``handle`` is a human whose password it is, and ``Throttled`` while ``(peer, handle)`` is locked.

        Pairing never comes here, so no number of failures here can lock anyone out of ``opencorp pair``.
        """
        key = (peer, handle)
        if (wait := self.throttle.wait(key)) is not None:
            raise Throttled(wait)
        phc = await self.sessions.password_hash(handle)
        # scrypt costs about 64 MiB and a tenth of a second: off the loop.
        matched = await asyncio.to_thread(check_password, password, phc or DUMMY_HASH)
        if phc is None or not matched:
            self.throttle.failed(key)
            raise BadCredentials
        self.throttle.succeeded(key)
        return password_fp(phc)

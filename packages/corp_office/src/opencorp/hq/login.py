"""Signing a browser in with a handle and password, checked against the person's hash at HEAD."""

from __future__ import annotations

import asyncio

from opencorp.auth.passwords import check_password
from opencorp.hq.sessions import BrowserSessions, password_fp


class BadCredentials(Exception):
    """The handle and password don't sign anyone in; which part was wrong is never said."""


class Logins:
    """Checks sign-in passwords for HQ. Use it on the office loop; password checks run in threads."""

    def __init__(self, sessions: BrowserSessions) -> None:
        self.sessions = sessions

    async def check(self, handle: str, password: str) -> str:
        """The fingerprint of the password hash ``password`` matches, ``handle``'s at HEAD; raises ``BadCredentials``
        unless ``handle`` is a human whose password it is."""
        phc = await self.sessions.password_hash(handle)
        # scrypt costs about 64 MiB and a tenth of a second: off the loop.
        if phc is None or not await asyncio.to_thread(check_password, password, phc):
            raise BadCredentials
        return password_fp(phc)

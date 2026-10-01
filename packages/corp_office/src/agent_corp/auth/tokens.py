"""Device tokens: long random secrets a device sends as ``Authorization: Bearer <token>``.

The company repo lists only each token's sha256, which can't be reversed into the token.
"""

import base64
import hashlib
import re
import secrets
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from agent_corp.auth.roster import Roster

PREFIX = "act_"
_TOKEN = re.compile(r"act_[A-Za-z0-9_-]{43}")
_BEARER = re.compile(r"[Bb][Ee][Aa][Rr][Ee][Rr] +(\S+)")


class AuthError(Exception):
    """A request the office can't tie to a person; ``code`` is the 401's error code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code, self.message = code, message


def new_token() -> str:
    """A new device token: ``act_`` and 32 random bytes in unpadded base64url."""
    return PREFIX + base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()


def token_sha256(token: str) -> str:
    """The lowercase hex sha256 of ``token``: what ``person.yaml`` lists."""
    return hashlib.sha256(token.encode()).hexdigest()


def authenticate(header: str | None, roster: "Roster") -> tuple[str, str]:
    """The ``(handle, device)`` whose token the ``Authorization`` header carries.

    Raises:
        AuthError: ``unauthenticated`` with no header; ``bad_token`` for a malformed header or
            a token no human lists. Messages never include the token.
    """
    if header is None:
        raise AuthError("unauthenticated", "this office needs a device token; run `ac login`")
    match = _BEARER.fullmatch(header.strip())
    if match is None or not _TOKEN.fullmatch(match[1]):
        raise AuthError("bad_token", "the Authorization header isn't `Bearer <device token>`")
    owner = roster.tokens.get(token_sha256(match[1]))
    if owner is None:
        raise AuthError("bad_token", "the office doesn't know this device; run `ac login`")
    return owner

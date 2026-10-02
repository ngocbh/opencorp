"""Passwords, kept only as salted scrypt hashes in PHC form: ``$scrypt$ln=15,r=8,p=1$<salt>$<hash>``."""

import base64
import binascii
import hashlib
import hmac
import os
import re

MIN_LENGTH = 8
_LN, _R, _P = 15, 8, 1
_PHC = re.compile(r"\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)")
_MAX_LN, _MAX_P, _MAX_MEMORY = 17, 4, 256 * 1024 * 1024
"""The most work a check does: a hash comes from the company repo, so it can't ask for unbounded time or memory."""


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.b64decode(text + "=" * (-len(text) % 4), validate=True)


def _scrypt(password: str, salt: bytes, ln: int, r: int, p: int, length: int) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, n=1 << ln, r=r, p=p, maxmem=_MAX_MEMORY, dklen=length)


def password_problem(password: str) -> str | None:
    """Why ``password`` can't be a new password, or None if it can."""
    return f"use at least {MIN_LENGTH} characters" if len(password) < MIN_LENGTH else None


def hash_password(password: str) -> str:
    """A new salted hash of ``password``; takes about a tenth of a second."""
    salt = os.urandom(16)
    return f"$scrypt$ln={_LN},r={_R},p={_P}${_b64(salt)}${_b64(_scrypt(password, salt, _LN, _R, _P, 32))}"


def check_password(password: str, phc: str | None) -> bool:
    """Whether ``password`` is the one ``phc`` hashes; False for no hash or one this office can't check."""
    match = _PHC.fullmatch(phc or "")
    if match is None:
        return False
    ln, r, p = (int(g) for g in match.groups()[:3])
    if ln > _MAX_LN or p > _MAX_P:
        return False
    try:
        salt, want = _unb64(match[4]), _unb64(match[5])
        got = _scrypt(password, salt, ln, r, p, len(want))
    except (binascii.Error, ValueError, MemoryError, OverflowError):
        return False
    return hmac.compare_digest(got, want)

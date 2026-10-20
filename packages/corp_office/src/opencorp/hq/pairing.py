"""One-time pairing codes (5 minutes), with an optional redirect file to open, so a code never sits in a process's
arguments. There's no failure throttle: 128 bits can't be guessed in 5 minutes, redeeming costs one hash lookup, and
a throttle would only let a co-tenant lock the owner out."""

import asyncio
import hashlib
import html
import logging
import secrets
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from opencorp.secrets import write_private

log = logging.getLogger(__name__)

TTL = timedelta(minutes=5)
MAX_PENDING = 16


@dataclass(frozen=True)
class Pending:
    """Who a code signs a browser in as, who asked for it, and until when."""

    handle: str
    issuer: str
    expires_at: datetime
    file: Path | None


@dataclass(frozen=True)
class Minted:
    """A new code, its expiry, and its redirect file if one was written."""

    code: str
    expires_at: datetime
    file: Path | None


def _key(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


class PairCodes:
    """The codes waiting to be used, by their sha256, in memory only. Use it on one thread (the office loop)."""

    def __init__(self, office_dir: Path, *, clock: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self.office_dir = office_dir
        self.clock = clock
        self._pending: OrderedDict[str, Pending] = OrderedDict()

    def mint(self, handle: str, *, issuer: str, url: Callable[[str], str | None], open_file: bool) -> Minted:
        """A new code for ``handle``; with ``open_file`` and a URL for it, a 0600 redirect file in the office dir."""
        self.sweep()
        while len(self._pending) >= MAX_PENDING:
            self._drop(next(iter(self._pending)))
        code = secrets.token_urlsafe(16)
        expires_at = self.clock() + TTL
        link = url(code)
        file = None
        if open_file and link is not None:
            file = self.office_dir / f"pair-{secrets.token_hex(8)}.html"
            href = html.escape(link, quote=True)
            write_private(file, (f'<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url={href}">'
                                 f'<title>OpenCorp HQ</title><a href="{href}">Open OpenCorp HQ</a>\n').encode())
        self._pending[_key(code)] = Pending(handle, issuer, expires_at, file)
        try:
            asyncio.get_running_loop().call_later(TTL.total_seconds() + 1, self.sweep)
        except RuntimeError:  # no running loop; mint and redeem sweep anyway
            pass
        log.info("pairing code minted for @%s by @%s", handle, issuer)  # never the code
        return Minted(code, expires_at, file)

    def redeem(self, code: str) -> Pending | None:
        """Spend ``code``: who it signs in as, or None if it's wrong, used or expired."""
        self.sweep()
        pending = self._pending.pop(_key(code), None)
        if pending is not None and pending.file is not None:
            pending.file.unlink(missing_ok=True)
        return pending

    def sweep(self) -> None:
        """Forget expired codes and delete their files."""
        now = self.clock()
        for key in [k for k, p in self._pending.items() if p.expires_at <= now]:
            self._drop(key)

    def close(self) -> None:
        """Forget every code and delete the files (the office is stopping)."""
        for key in list(self._pending):
            self._drop(key)

    def _drop(self, key: str) -> None:
        pending = self._pending.pop(key)
        if pending.file is not None:
            pending.file.unlink(missing_ok=True)

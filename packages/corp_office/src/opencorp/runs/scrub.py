"""What every run-log record passes before it leaves the office: secret-named keys hidden, secret shapes and every
known secret value removed, then checked again. A record that can't be made clean is withheld."""

import json
import logging
import re
from collections.abc import Iterable
from typing import Any

from opencorp.company.secret_keys import HIDDEN, MIN_KNOWN, check_clean, is_secret_key, scrub_text
from opencorp.perm.monitor import redactor

log = logging.getLogger(__name__)

HEADER_KEYS = frozenset({"authorization", "proxy_authorization", "cookie", "set_cookie"})
"""Credential headers, as ``is_secret_key`` normalizes keys: secret keys too."""
_NOT_HIDDEN = r"(?!\(hidden\))"
PROVIDER_KEY = re.compile(r"\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}")
"""A provider key's shape (OpenAI's ``sk-…``, Anthropic's ``sk-ant-…``), configured here or not."""
BEARER = re.compile(rf"\b(Bearer)\s+{_NOT_HIDDEN}\S{{8,}}", re.IGNORECASE)
AUTH_HEADER = re.compile(rf"\b(authorization[\"']?\s*[:=]\s*[\"']?(?:Bearer|Basic|Token))\s+{_NOT_HIDDEN}[^\s\"',}}]+",
                         re.IGNORECASE)
"""An ``Authorization: Basic …`` or ``Token …`` header value (Proxy-Authorization too), as text."""
API_KEY_HEADER = re.compile(rf"\b((?:x-)?api[-_]key)([\"']?\s*[:=]\s*[\"']?){_NOT_HIDDEN}[^\s\"',}}]+",
                            re.IGNORECASE)
"""An ``api-key: …`` header value, which provider errors echo, as text, JSON or a Python repr."""
WITHHELD = "a secret couldn't be removed"
_KIND = re.compile(r"[a-z_]{1,64}")


def secret_key(key: object) -> bool:
    """Whether ``key`` names a secret: #247's rule, or a credential header such as Authorization or Cookie."""
    return is_secret_key(key) or (isinstance(key, str)
                                  and key.lower().replace("-", "_").replace(" ", "_") in HEADER_KEYS)


def scrub_string(text: str) -> str:
    """``text`` with every secret of a known shape replaced by ``(hidden)``: #247's patterns and URL passwords,
    provider keys, bearer tokens, Authorization and api-key header values. No I/O: safe anywhere, run reasons
    included."""
    text = PROVIDER_KEY.sub(HIDDEN, scrub_text(text))
    text = BEARER.sub(lambda m: f"{m[1]} {HIDDEN}", text)
    text = AUTH_HEADER.sub(lambda m: f"{m[1]} {HIDDEN}", text)
    return API_KEY_HEADER.sub(lambda m: f"{m[1]}{m[2]}{HIDDEN}", text)


class Scrubber:
    """Scrubs run-log records with one set of known secret values; its needles are built once, here."""

    def __init__(self, known: Iterable[str]) -> None:
        self.known = frozenset(v for v in known if isinstance(v, str) and len(v.strip()) >= MIN_KNOWN)
        self._redact = redactor(self.known)

    def _hide(self, value: Any) -> Any:
        """``value`` with every secret-named key's value hidden at any depth, keys read as written."""
        if isinstance(value, dict):
            return {k: HIDDEN if secret_key(k) else self._hide(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self._hide(v) for v in value]
        return value

    def value(self, value: Any) -> Any:
        """``value`` with secret-named keys' values hidden at any depth and every string (keys too) scrubbed."""
        if isinstance(value, str):
            return scrub_string(value)
        if isinstance(value, dict):
            scrubbed: dict[Any, Any] = {}
            for k, v in value.items():
                key = new = self.value(k) if isinstance(k, str) else k
                n = 1
                while new in scrubbed:  # two keys scrubbed to the same text: keep both values, as redact does
                    n += 1
                    new = f"{key}#{n}"
                scrubbed[new] = HIDDEN if secret_key(k) else self.value(v)
            return scrubbed
        if isinstance(value, list):
            return [self.value(v) for v in value]
        return value

    def clean(self, text: str) -> bool:
        """Whether ``text`` holds no secret shape and no known value, plain or escaped."""
        return (check_clean(text, self.known) and not PROVIDER_KEY.search(text) and not BEARER.search(text)
                and not AUTH_HEADER.search(text) and not API_KEY_HEADER.search(text) and self._redact(text) == text)

    def record(self, record: dict[str, Any]) -> dict[str, Any]:
        """``record`` scrubbed (secret-named keys, then known values in plain, JSON, repr and URL forms, then shapes)
        and checked; a withheld stub (seq, kind, node id) when the scrub raises or the check fails.

        The key rule reads keys as written, before a known value equal to part of a key name rewrites it. Known values
        go before shapes, so a shape that matches part of one (a DSN's password, a ``$…$`` tail) can't split it and
        leave the rest of it shown."""
        try:
            out = self.value(self._redact(self._hide(record)))
            if self.clean(json.dumps(out, ensure_ascii=False)):
                return out
        except Exception:
            log.warning("a run-log record couldn't be scrubbed; it is withheld")
        return self._withheld(record)

    def text(self, value: str) -> str:
        """One string (a node's error, a run's reason) scrubbed, or WITHHELD when it can't be made clean."""
        out = self.record({"text": value})
        return out["text"] if "text" in out else WITHHELD

    def line(self, raw: bytes) -> bytes:
        """One log line for the download, scrubbed and written back as one JSON line; a line that doesn't parse as a
        JSON object is withheld."""
        try:
            parsed = json.loads(raw)
        except ValueError:
            parsed = None
        out = self.record(parsed) if isinstance(parsed, dict) else {"withheld": WITHHELD}
        return json.dumps(out, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode() + b"\n"

    def _withheld(self, record: dict[str, Any]) -> dict[str, Any]:
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        kind, seq, node = record.get("kind"), record.get("seq"), payload.get("node_id")
        stub = {"seq": seq if type(seq) is int else None,
                "kind": kind if isinstance(kind, str) and _KIND.fullmatch(kind) else "unknown", "withheld": WITHHELD}
        if isinstance(node, str) and self.clean(node):
            stub["node_id"] = node
        return stub

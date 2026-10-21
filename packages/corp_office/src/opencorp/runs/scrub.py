"""What every run-log record passes before it leaves the office: secret-named keys hidden, secret shapes and every
known secret value removed, then checked again. A record that can't be made clean is withheld."""

import functools
import json
import logging
import re
from collections.abc import Callable, Iterable
from typing import Any

from opencorp.company.secret_keys import HIDDEN, MIN_KNOWN, check_clean, is_secret_key, key_name, scrub_text
from opencorp.perm.monitor import redactor

log = logging.getLogger(__name__)

HEADER_KEYS = frozenset({"authorization", "proxy_authorization", "cookie", "set_cookie"})
"""Credential headers, as ``key_name`` reads keys: secret keys too."""
_NOT_HIDDEN = r"(?!\(hidden\))"
_QUOTE = r"(?:\\{0,15}[\"'])?"  # a quote, escaped up to 4 times (JSON inside JSON), or none
_VALUE = r"(?:[^\s\"',}\\]|\\(?![\\\"']))+"  # up to a quote, escaped or not
PROVIDER_KEY = re.compile(r"sk-(?:(?<![A-Za-z0-9]sk-)|(?=[A-Za-z0-9_-]{0,64}?(?=[A-Za-z0-9]{16})[A-Za-z0-9]{0,15}"
                          r"[A-Z]))(?:ant-)?[A-Za-z0-9_-]{16,}")
"""A provider key's shape (OpenAI's ``sk-…``, Anthropic's ``sk-ant-…``), configured here or not. Glued after a letter
or digit, it needs a run of 16 letters and digits with a capital among them, so ``risk-assessment-…``,
``task-<hex>`` and ``kiosk-…`` stay. ``sk-`` comes first, so the search looks for that literal."""
BEARER = re.compile(rf"\b(Bearer)\s+{_NOT_HIDDEN}\S{{8,}}", re.IGNORECASE)
AUTH_HEADER = re.compile(rf"\b(authorization{_QUOTE}\s*[:=]\s*{_QUOTE}(?:Bearer|Basic|Token))\s+{_NOT_HIDDEN}{_VALUE}",
                         re.IGNORECASE)
"""An ``Authorization: Basic …`` or ``Token …`` header value (Proxy-Authorization too), as text."""
_FOLDED = r"(?:\r?\n|(?:\\r)?\\n)(?=[ \t]|\\t)"  # a line break, plain or escaped, that a folded header goes on after
AUTH_DIGEST = re.compile(rf"\b(authorization{_QUOTE}\s*[:=]\s*{_QUOTE}Digest)\s+{_NOT_HIDDEN}"
                         rf"(?:[^\r\n\\]|\\(?![rn])|{_FOLDED})+", re.IGNORECASE)
"""An ``Authorization: Digest …`` header value, whose parameters hold spaces and quotes: up to the end of its line,
and of each line folded onto it."""
API_KEY_HEADER = re.compile(rf"\b((?:x-)?api[-_]key)({_QUOTE}\s*[:=]\s*{_QUOTE}){_NOT_HIDDEN}{_VALUE}", re.IGNORECASE)
"""An ``api-key: …`` header value, which provider errors echo, as text, JSON (escaped too) or a Python repr."""
QUOTED_PAIR = re.compile(r"""(?<!\\)(?P<bs>\\{0,15})(?P<q>["'])"""  # a quote and its escapes, the same around both
                         r"""(?P<key>[A-Za-z0-9_][A-Za-z0-9_ .-]{0,63})(?P=bs)(?P=q)\s*:\s*"""
                         r"""(?=(?P=bs)(?P<vq>["'])(?P<value>.*?(?<!\\)(?:(?P=bs)\\(?P=bs)\\)*)(?P=bs)(?P=vq)"""
                         r"""|(?P<bare>-?[0-9][\w.+-]*))""", re.DOTALL)
"""A ``"key": value`` pair of JSON (escaped too) or a Python repr inside a string; ``secret_key`` decides whether its
value is hidden. The value ends at the quote whose backslashes are the quote's own escapes after whole escaped
backslashes, which end the value. It is read ahead, not consumed, so a pair inside another pair's value is found too.
Quotes escaped up to 4 times count, so each search stays linear."""
_KEY_WORDS = ("passw", "token", "secret", "key", "devices", "authorization", "cookie")
"""A word every secret key holds, lowercased (``key_name`` only adds ``_`` and lowercases): ``QUOTED_PAIR`` is tried
only at the quote before one, so ordinary text and pairs cost a few substring searches."""
WITHHELD = "a secret couldn't be removed"
_KIND = re.compile(r"[a-z_]{1,64}")


@functools.lru_cache(maxsize=4096)  # a log repeats its few key names in every record
def secret_key(key: object) -> bool:
    """Whether ``key`` (hashable: a mapping key) names a secret: #247's rule, or a credential header such as
    Authorization or Cookie."""
    return is_secret_key(key) or (isinstance(key, str) and key_name(key) in HEADER_KEYS)


def _secret_values(text: str) -> list[tuple[int, int]]:
    """Where the values of secret-named quoted pairs in ``text`` are that aren't ``(hidden)`` yet, outermost first; a
    pair inside one of them is left out, since it goes with it."""
    found: list[tuple[int, int]] = []
    for m in _pairs(text):
        group = "value" if m["vq"] is not None else "bare"
        if (found and m.start() < found[-1][1]) or not secret_key(m["key"]) or m[group] == HIDDEN:
            continue
        found.append(m.span(group))
    return found


def _pairs(text: str) -> list[re.Match[str]]:
    """The quoted pairs in ``text`` whose key holds one of ``_KEY_WORDS``, in order: ``QUOTED_PAIR`` tried at the
    nearest quote before each such word (a key holds no quote), and at the start of that quote's backslashes."""
    low = text.lower()
    if len(low) != len(text):  # a character lower() lengthens: positions would drift, so try everywhere
        return list(QUOTED_PAIR.finditer(text))
    starts = set()
    for word in _KEY_WORDS:
        at = low.find(word)
        while at != -1:
            quote = max(text.rfind('"', max(at - 64, 0), at), text.rfind("'", max(at - 64, 0), at))
            if quote != -1:
                start = quote
                while start > quote - 15 and start > 0 and text[start - 1] == "\\":
                    start -= 1
                starts.add(start)
            at = low.find(word, at + 1)
    return [m for start in sorted(starts) if (m := QUOTED_PAIR.match(text, start))]


def _hide_pairs(text: str) -> str:
    out, at = [], 0
    for start, end in _secret_values(text):
        out += [text[at:start], HIDDEN]
        at = end
    return "".join(out) + text[at:]


_SHAPES: tuple[tuple[re.Pattern[str], Callable[[re.Match[str]], str], tuple[str, ...]], ...] = (
    (BEARER, lambda m: f"{m[1]} {HIDDEN}", ("bearer",)),
    (AUTH_HEADER, lambda m: f"{m[1]} {HIDDEN}", ("authorization",)),
    (AUTH_DIGEST, lambda m: f"{m[1]} {HIDDEN}", ("authorization",)),
    (API_KEY_HEADER, lambda m: f"{m[1]}{m[2]}{HIDDEN}", ("api-key", "api_key")),
)
"""The header shapes, each with how it's hidden and the words, lowercased, one of which it can't match without."""


def _lowered(text: str) -> str | None:
    """``text`` lowercased, to test for a shape's words before its case-blind search; None when it holds a dotted or
    dotless capital I, which the search reads as ``i`` and ``lower()`` doesn't turn into one."""
    return None if "\u0130" in text or "\u0131" in text else text.lower()


def _may_hold(low: str | None, words: tuple[str, ...]) -> bool:
    return low is None or any(word in low for word in words)


def scrub_string(text: str) -> str:
    """``text`` with every secret of a known shape replaced by ``(hidden)``: #247's patterns and URL passwords,
    provider keys, bearer tokens, Authorization and api-key header values, and the values of secret-named pairs of
    JSON or a repr inside it. No I/O: safe anywhere, run reasons included."""
    text = PROVIDER_KEY.sub(HIDDEN, scrub_text(text))
    low = _lowered(text)
    for pattern, hide, words in _SHAPES:
        if _may_hold(low, words):
            new = pattern.sub(hide, text)
            if new != text:
                text, low = new, _lowered(new)
    return _hide_pairs(text)


def _has_shape(text: str) -> bool:
    """Whether ``text`` still holds a secret shape ``scrub_string`` removes."""
    if PROVIDER_KEY.search(text):
        return True
    low = _lowered(text)
    return (any(_may_hold(low, words) and pattern.search(text) for pattern, _, words in _SHAPES)
            or bool(_secret_values(text)))


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
        return check_clean(text, self.known) and not _has_shape(text) and self._redact(text) == text

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

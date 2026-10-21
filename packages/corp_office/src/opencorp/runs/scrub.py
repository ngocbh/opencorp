"""What every run-log record passes before it leaves the office: secret-named keys hidden, secret shapes and every
known secret value removed, then checked again. A record that can't be made clean is withheld."""

import functools
import json
import logging
import re
import unicodedata
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
                         r"""(?P<key>\w[\w .-]{0,63})(?P=bs)(?P=q)\s*:\s*(?=(?P=bs)[bBrR]{0,2}(?P<vq>["'])"""
                         r"""(?P<value>.*?(?<!\\)(?:(?P=bs)\\(?P=bs)\\)*)(?P=bs)(?P=vq)|(?P<bare>-?[0-9][\w.+-]*))""",
                         re.DOTALL)
"""A ``"key": value`` pair of JSON (escaped too) or a Python repr (a ``b'…'`` or ``rb'…'`` value too) inside a string,
searched for in ``_folded`` text, so a lookalike ``:`` or ``_`` counts; ``secret_key`` decides from the key as written
whether its value is hidden. The value ends at the quote whose backslashes are the quote's own escapes after
whole escaped backslashes, which end the value. It is read ahead, not consumed, so a pair inside another pair's value is
found too. Quotes escaped up to 4 times count, so each search stays linear."""
_KEY_WORDS = ("passw", "token", "secret", "key", "phrase", "devices", "authorization", "cookie")
"""A word every secret key holds, as ``_folded`` reads it (``key_name`` only adds ``_``, NFKC-normalizes and
lowercases): ``QUOTED_PAIR`` and ``BARE_PAIR`` are tried only at a key holding one, so ordinary text costs a few
substring searches. The first five are the words of ``is_secret_key``'s keys."""
_ENDS = r"(?:[\s,;:}\])]|$)"  # after a quote that closes the string around a pair rather than opens its value
BARE_PAIR = re.compile(rf"(?P<key>\w[\w.-]{{0,135}})[ \t]*+[:=](?!=)[ \t]*+"
                       r"(?!(?:\(hidden\)|\[redacted\]|(?i:true|false|null|none))(?=[ \t]*+(?:[,;}\])\r\n\"']|\\|$)))"
                       rf"(?:[bBrRuU]{{0,2}}(?P<q>[\"'])(?!{_ENDS})(?P<quoted>(?:(?!(?P=q))[^\\\r\n]|\\.)*)(?P=q)"
                       rf"|(?P<line>(?:(?!\\{{0,15}}[\"']{_ENDS})(?:[^\r\n\\]|\\(?![rn])))+))")
"""A ``key: value`` or ``KEY=value`` pair in plain text (an env line, YAML, a log line, a keyword argument), whose key
is unquoted; ``is_secret_key`` decides whether its value is hidden.

A quoted value ends at its closing quote. Any other value runs to the end of its line (a plain or escaped line break),
since an unquoted YAML or ``.env`` value may hold spaces, or to a quote, escaped or not, that closes a string around
the pair (``{"m": "token: x", …}``); so does an unclosed quoted value. A whole value of ``true``, ``false``, ``null``
or ``none`` stays (``true-love-1985`` doesn't), and so does a string ending in ``password:``. Searched for in
``_folded`` text, so a lookalike ``=`` or ``_`` counts."""
_KEY_WORD = re.compile("|".join(_KEY_WORDS))
_BARE_WORD = re.compile(rf"(?:{'|'.join(_KEY_WORDS[:5])})[\w.-]{{0,64}}+(?P<sep>[ \t]*+[:=](?!=))")
"""A word of ``is_secret_key``'s keys, the rest of its key and a separator, in folded text: where ``BARE_PAIR`` may
match, bounded."""
COOKIE_HEADER = re.compile(r"\b((?:set-)?cookie[ \t]*:[ \t]*)(?=[\w!#$%&*+.^`|~-]{1,256}=)"
                           r"(?:[^\r\n\\]|\\(?![rn])|(?:\r?\n|(?:\\r)?\\n)(?=[ \t]|\\t))+", re.IGNORECASE)
"""A ``Cookie:`` or ``Set-Cookie:`` header written as text, its value (``name=…``) up to the end of its line and of each
line folded onto it; a quoted value is a quoted pair's."""
WITHHELD = "a secret couldn't be removed"
_KIND = re.compile(r"[a-z_]{1,64}")


@functools.lru_cache(maxsize=4096)  # a log repeats its few key names in every record
def secret_key(key: object) -> bool:
    """Whether ``key`` (hashable: a mapping key) names a secret: #247's rule, or a credential header such as
    Authorization or Cookie."""
    return is_secret_key(key) or (isinstance(key, str) and key_name(key) in HEADER_KEYS)


@functools.lru_cache(maxsize=4096)
def _bare_secret_key(key: str) -> bool:
    """Whether an unquoted key in text names a secret: credential headers have their own shapes, and ``devices`` is a
    secret only as a person file's key."""
    return is_secret_key(key) and key_name(key).replace("_", "") != "devices"


@functools.cache
def _compat() -> tuple[frozenset[str], dict[int, str]]:
    """The characters NFKC turns into one ASCII letter, digit or one of ``_.-:=`` (a Kelvin sign, fullwidth and
    mathematical letters, a fullwidth ``＿`` or ``＝``), and ``İ``, whose lowercase is two characters: the set of them
    and a ``str.translate`` table to those characters."""
    table = {"\u0130": "i"}
    for point in range(0x80, 0x20000):
        char = chr(point)
        norm = unicodedata.normalize("NFKC", char)
        if len(norm) == 1 and norm.isascii() and (norm.isalnum() or norm in "_.-:="):
            table[char] = norm
    return frozenset(table), str.maketrans(table)


def _folded(text: str) -> str:
    """``text`` lowercased as ``key_name`` reads a key, for finding pairs: a character ``_compat`` holds is read as
    its ASCII character first, so a lookalike key or separator is found, and positions stay those of ``text``."""
    if not text.isascii() and (not unicodedata.is_normalized("NFKC", text) or "\u0130" in text):
        chars, table = _compat()
        if not chars.isdisjoint(set(text)):
            text = text.translate(table)
    return text.lower()


def _secret_values(text: str, low: str) -> list[tuple[int, int]]:
    """Where the values of secret-named quoted pairs in ``text`` (``low``: it ``_folded``) are that aren't
    ``(hidden)`` yet, outermost first; a pair inside one of them is left out, since it goes with it."""
    found: list[tuple[int, int]] = []
    for m in _pairs(text, low):
        group = "value" if m["vq"] is not None else "bare"
        key = text[m.start("key"):m.end("key")]  # as written, so camelCase splits
        if (found and m.start() < found[-1][1]) or not secret_key(key) or m[group] == HIDDEN:
            continue
        found.append(m.span(group))
    return found


def _pairs(text: str, low: str) -> list[re.Match[str]]:
    """The quoted pairs in ``text`` whose key holds one of ``_KEY_WORDS``, in order: ``QUOTED_PAIR`` tried at the
    nearest quote before each such word (a key holds no quote), and at the start of that quote's backslashes."""
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
    return [m for start in sorted(starts) if (m := QUOTED_PAIR.match(low, start))]


def _bare_values(text: str, low: str) -> list[tuple[int, int]]:
    """Where the values of secret-named ``BARE_PAIR`` pairs in ``text`` (``low``: it ``_folded``) are that aren't
    ``(hidden)`` yet, in order.

    ``BARE_PAIR`` is tried where the key holding each of ``_KEY_WORDS`` starts (up to 64 key characters before the
    word, after any leading ``-`` or ``.``: ``--password=…``), once the key as written passes ``_bare_secret_key``,
    since its value may run to the end of the line. A word inside a key or value already read is skipped, so each
    search stays linear."""
    found: list[tuple[int, int]] = []
    done = 0
    for word in _BARE_WORD.finditer(low):
        at = word.start()
        if at < done:
            continue
        start = at
        while start > max(at - 64, done) and (low[start - 1].isalnum() or low[start - 1] in "_.-"):
            start -= 1
        while start < at and low[start] in ".-":
            start += 1
        if not _bare_secret_key(text[start:word.start("sep")]):
            continue  # before BARE_PAIR, which reads the value to the end of its line
        m = BARE_PAIR.match(low, start)
        if m is None:
            continue
        group = "quoted" if m["q"] is not None else "line"
        if m[group] and m[group] != HIDDEN:
            found.append(m.span(group))
        done = m.end()
    return found


def _splice(text: str, spans: list[tuple[int, int]]) -> str:
    """``text`` with each of ``spans``, in order and apart, replaced by ``(hidden)``."""
    out, at = [], 0
    for start, end in spans:
        out += [text[at:start], HIDDEN]
        at = end
    return "".join(out) + text[at:]


_SHAPES: tuple[tuple[re.Pattern[str], Callable[[re.Match[str]], str], tuple[str, ...]], ...] = (
    (BEARER, lambda m: f"{m[1]} {HIDDEN}", ("bearer",)),
    (AUTH_HEADER, lambda m: f"{m[1]} {HIDDEN}", ("authorization",)),
    (AUTH_DIGEST, lambda m: f"{m[1]} {HIDDEN}", ("authorization",)),
    (API_KEY_HEADER, lambda m: f"{m[1]}{m[2]}{HIDDEN}", ("api-key", "api_key")),
    (COOKIE_HEADER, lambda m: f"{m[1]}{HIDDEN}", ("cookie",)),
)
"""The header shapes, each with how it's hidden and the words, lowercased, one of which it can't match without."""
_SHAPE_WORD = re.compile("|".join(re.escape(word) for _, _, words in _SHAPES for word in words))
"""Any shape's word: one search of a short string, rather than a substring search per word."""


def _lowered(text: str) -> str | None:
    """``text`` lowercased, to test for a shape's words before its case-blind search; None when it holds a dotted or
    dotless capital I, which the search reads as ``i`` and ``lower()`` doesn't turn into one."""
    return None if "\u0130" in text or "\u0131" in text else text.lower()


def _shapes(low: str | None) -> list[tuple[re.Pattern[str], Callable[[re.Match[str]], str], tuple[str, ...]]]:
    """The shapes ``low`` (``_lowered``) may hold, in order."""
    if low is None:
        return list(_SHAPES)
    if len(low) < 4096 and not _SHAPE_WORD.search(low):  # most strings: no word at all
        return []
    return [shape for shape in _SHAPES if any(word in low for word in shape[2])]


def scrub_string(text: str) -> str:
    """``text`` with every secret of a known shape replaced by ``(hidden)``: #247's patterns and URL passwords,
    provider keys, bearer tokens, Authorization, api-key and Cookie header values, the values of secret-named pairs of
    JSON or a repr inside it, and those of secret-named ``key: value`` and ``KEY=value`` pairs of plain text. The
    whole of ``text`` when a plain-text pair is still found after (a bug). No I/O: safe anywhere, run reasons
    included."""
    text = PROVIDER_KEY.sub(HIDDEN, scrub_text(text))
    for pattern, hide, _ in _shapes(_lowered(text)):
        text = pattern.sub(hide, text)  # it adds no word, so the test on the text before still holds
    low = _folded(text)
    if not _KEY_WORD.search(low):
        return text
    if spans := _secret_values(text, low):
        text, low = _splice(text, spans), _splice(low, spans)  # low stays text folded: (hidden) is lowercase
    if spans := _bare_values(text, low):
        text, low = _splice(text, spans), _splice(low, spans)
        # Checked here, not in the record's JSON, where a string ending in "password:" would read as a pair.
        if _bare_values(text, low):
            return HIDDEN
    return text


def _has_shape(text: str) -> bool:
    """Whether ``text`` still holds a secret shape ``scrub_string`` removes."""
    if PROVIDER_KEY.search(text):
        return True
    return (any(pattern.search(text) for pattern, _, _ in _shapes(_lowered(text)))
            or bool(_secret_values(text, _folded(text))))


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

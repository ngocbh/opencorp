"""What counts as a secret in the company repo, for everything the office shows a browser: secret-named keys, the
patterns of the secrets the office issues, a scrub and a final check."""

import base64
import json
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any

import yaml
from pydantic import BaseModel

_CAMEL = (re.compile(r"(?<=[A-Z])(?=[A-Z][a-z])"), re.compile(r"(?<=[a-z0-9])(?=[A-Z])"))
"""Word breaks in a camelCase or PascalCase key: an acronym before a word (``APIKey``), and a capital after a lowercase
letter or digit (``accessToken``). Lookarounds only, so a long run of capitals is read in linear time."""

SECRET_KEYS = frozenset({"devices", "password", "passwd", "password_hash", "token", "token_sha256", "secret",
                         "client_secret", "api_key", "apikey", "access_token", "refresh_token", "private_key",
                         "secret_key", "secret_access_key", "passphrase"})
"""Keys whose values are secrets, as ``is_secret_key`` normalizes them."""

SECRET_SUFFIXES = ("_password", "_token", "_secret", "_api_key", "_private_key", "_secret_key", "_secret_access_key",
                   "_passphrase")
"""Endings that make a normalized key a secret key too."""

_JOINED_KEYS = frozenset(k.replace("_", "") for k in SECRET_KEYS)
_JOINED_SUFFIXES = tuple(s.replace("_", "") for s in SECRET_SUFFIXES)
"""``SECRET_KEYS`` and ``SECRET_SUFFIXES`` without ``_``, for a key written without separators (``accesstoken``,
``ACCESSTOKEN``, ``clientsecret``); a separated key that matches the rules matches these too."""

DEVICES = "devices"
"""Holds device names, which aren't secrets, beside each device's ``token_sha256``, which is."""

HIDDEN = "(hidden)"
"""What a scrubbed secret, or a commit subject or author that fails the check, becomes."""

SECRET_PATTERNS = (
    re.compile(r"act_[A-Za-z0-9_-]{43}"),  # a device token; no word boundaries, so a glued copy matches too
    re.compile(r"\$[a-z0-9-]+\$[^\s'\"]+"),  # a PHC string, as the schema's PasswordHash allows
)
"""Secrets with a known format, each replaced whole by ``scrub_text``."""

URL_CREDENTIALS = re.compile(r"(://[^\s/@:]*:)(?!\(hidden\)@)\S{1,1024}@(?=[^\s/@?#'\"]*(?:[\s/?#'\"]|$))")
"""The password in ``scheme://user:password@host``, up to the last ``@`` before the host, so one holding ``/`` or
``@`` is hidden whole; one already scrubbed doesn't match again. Bounded at 1024 characters, so a long run of text
with no whitespace and many ``://h:port`` can't make the search quadratic."""

MIN_KNOWN = 8
"""Known secret values shorter than this are ignored by ``check_clean``, so they don't match everywhere."""

YAML_BUDGET = 100_000
"""The most values ``find_secrets`` visits, counting every alias reference: an alias bomb runs out of it."""


def key_name(key: str) -> str:
    """``key`` as the secret rules read it: NFKC-normalized (so a Kelvin sign or a fullwidth letter is its ASCII
    letter), camelCase words split by ``_``, lowercased, ``-``, ``.`` and spaces as ``_`` (so
    ``spring.datasource.password`` ends in ``_password``)."""
    key = unicodedata.normalize("NFKC", key)
    for pattern in _CAMEL:
        key = pattern.sub("_", key)
    return key.lower().replace("-", "_").replace(".", "_").replace(" ", "_")


def is_secret_key(key: object) -> bool:
    """Whether ``key``, read by ``key_name`` (so ``accessToken`` is ``access_token``), names a secret, written with
    separators or without (``accesstoken``)."""
    if not isinstance(key, str):
        return False
    norm = key_name(key)
    if norm in SECRET_KEYS or norm.endswith(SECRET_SUFFIXES):
        return True
    joined = norm.replace("_", "")
    return joined in _JOINED_KEYS or joined.endswith(_JOINED_SUFFIXES)


def blank_secrets[M: BaseModel](model: M) -> M:
    """``model`` with every secret-named field (a person's devices and password hash) set to its default."""
    secret = {name: info for name, info in type(model).model_fields.items() if is_secret_key(name)}
    # A required field has no default to blank it to; the schema must give secret fields one.
    assert not any(info.is_required() for info in secret.values()), f"a required secret field in {type(model)}"
    return model.model_copy(update={name: info.get_default(call_default_factory=True) for name, info in secret.items()})


def scrub_text(text: str) -> str:
    """``text`` with every secret of a known format (``SECRET_PATTERNS``, URL passwords) replaced by ``(hidden)``."""
    for pattern in SECRET_PATTERNS:
        text = pattern.sub(HIDDEN, text)
    return URL_CREDENTIALS.sub(lambda m: f"{m.group(1)}{HIDDEN}@", text)


def check_clean(text: str, known: set[str] | frozenset[str]) -> bool:
    """Whether ``text`` holds no secret of a known format and none of the ``known`` values of 8 characters or more."""
    if any(p.search(text) for p in SECRET_PATTERNS) or URL_CREDENTIALS.search(text):
        return False
    return not any(len(value) >= MIN_KNOWN and value in text for value in known)


class UnsafeYaml(Exception):
    """A YAML text couldn't be read safely: it doesn't parse, holds several documents, recurses, is too big or has a
    key that isn't a scalar."""


class NotYaml(UnsafeYaml):
    """The text doesn't parse as one YAML document (as JSON, for ``find_json_secrets``)."""


@dataclass
class YamlSecrets:
    """A parsed YAML text and its secrets."""

    data: Any
    """The document as SafeLoader builds it, or None when it's empty or has a tag SafeLoader doesn't know."""
    keys: list[tuple[Any, ...]] = field(default_factory=list)
    """The path to each secret key not inside another secret key's value, in document order."""
    values: set[str] = field(default_factory=set)
    """Every scalar under a secret key, keys included; under ``devices``, only those under secret keys within."""
    plain: set[str] = field(default_factory=set)
    """Every other scalar, keys included, decoded: an escaped or split secret is whole here."""


_PLAIN, _DEVICES, _SECRET = range(3)

_MERGE = "tag:yaml.org,2002:merge"
_BINARY = "tag:yaml.org,2002:binary"


def find_secrets(text: str) -> YamlSecrets:
    """Compose ``text`` with the pure-Python SafeLoader and collect its secret keys and values from the node graph,
    so tags (Yian's ``!Person``, ``!str``) don't matter; ``UnsafeYaml`` on any failure, so callers can fail closed."""
    try:
        loader = yaml.SafeLoader(text)  # pure Python, never the C loader; its reader refuses control characters
        root = loader.get_single_node()
    except yaml.YAMLError as exc:
        raise NotYaml(type(exc).__name__) from None
    except Exception as exc:  # RecursionError on deep nesting, and anything else: not safe
        raise UnsafeYaml(type(exc).__name__) from None
    found = YamlSecrets(None)
    try:
        _walk(found, root)
    except Exception as exc:  # a cycle, the budget, a non-scalar key: not safe
        raise UnsafeYaml(type(exc).__name__) from None
    if root is not None:
        try:  # after the walk, which bounds the graph; it rewrites merges in place
            found.data = loader.construct_document(root)
        except Exception:  # an unknown tag: no data, so nothing is re-rendered from it
            found.data = None
    loader.dispose()
    return found


class _Pairs(list):
    """A JSON object's pairs in order, duplicate keys kept, so a value json.loads would drop is checked too."""


def find_json_secrets(text: str) -> YamlSecrets:
    """``find_secrets`` for JSON that PyYAML can't read (tab indents, characters YAML refuses): ``json.loads`` and the
    same key rule and contexts; ``data`` is None. ``NotYaml`` when it doesn't parse, ``UnsafeYaml`` on any other
    failure."""
    try:
        # Numbers as written: int() refuses a very long one, which would turn the walk into the fallback.
        data = json.loads(text, object_pairs_hook=_Pairs, parse_int=str, parse_float=str, parse_constant=str)
    except ValueError as exc:
        raise NotYaml(type(exc).__name__) from None
    except Exception as exc:  # RecursionError on deep nesting: not safe
        raise UnsafeYaml(type(exc).__name__) from None
    found = YamlSecrets(None)
    stack: list[tuple[Any, tuple[Any, ...], int]] = [(data, (), _PLAIN)]
    visits = 0
    while stack:
        value, path, ctx = stack.pop()
        visits += 1
        if visits > YAML_BUDGET:
            raise UnsafeYaml("too many values")
        if isinstance(value, _Pairs):
            children = [(v, (*path, k), _key(found, path, ctx, k, [k])) for k, v in value]
        elif isinstance(value, list):
            children = [(v, (*path, i), ctx) for i, v in enumerate(value)]
        else:
            text = value if isinstance(value, str) else json.dumps(value)
            (found.values if ctx == _SECRET else found.plain).add(text)
            continue
        stack.extend(reversed(children))
    return found


def _key(found: YamlSecrets, path: tuple[Any, ...], ctx: int, key: Any, names: list[str]) -> int:
    """Record the mapping key ``key`` at ``path`` (``names``: its texts) and return its value's context."""
    (found.values if ctx == _SECRET else found.plain).update(names)
    if ctx == _SECRET or not any(is_secret_key(n) for n in names):
        return ctx
    if ctx == _PLAIN:
        found.keys.append((*path, key))
    return _DEVICES if any(n.lower() == DEVICES for n in names) else _SECRET


def _texts(node: yaml.ScalarNode) -> list[str]:
    """A scalar's text and, for a ``!!binary`` one, its decoded bytes as text too; raises when they aren't base64."""
    if node.tag != _BINARY:
        return [node.value]
    data = base64.decodebytes(node.value.encode("ascii"))  # as SafeConstructor decodes it
    return [node.value, data.decode("utf-8", "replace")]  # a secret's UTF-8 bytes stay whole among invalid ones


def _walk(found: YamlSecrets, root: yaml.Node | None) -> None:
    """Fill ``found.keys``, ``found.values`` and ``found.plain`` from the node graph, walking aliases each time they
    are referenced.

    Keys count by their scalar value, whatever their tag; a ``!!binary`` scalar, key or value, counts decoded too. A
    merge key's mappings are walked as part of the mapping holding it. ``on_path`` holds the containers on the current
    path, so a recursive anchor raises instead of looping.
    """
    stack: list[tuple[yaml.Node, tuple[Any, ...], int] | int] = [] if root is None else [(root, (), _PLAIN)]
    on_path: set[int] = set()
    visits = 0
    while stack:
        item = stack.pop()
        if isinstance(item, int):  # leaving a container
            on_path.discard(item)
            continue
        node, path, ctx = item
        visits += 1
        if visits > YAML_BUDGET:
            raise UnsafeYaml("too many values")
        if isinstance(node, yaml.ScalarNode):
            (found.values if ctx == _SECRET else found.plain).update(_texts(node))
            continue
        if id(node) in on_path:
            raise UnsafeYaml("recursive anchor")
        on_path.add(id(node))
        children: list[tuple[yaml.Node, tuple[Any, ...], int]] = []
        if isinstance(node, yaml.SequenceNode):
            children = [(v, (*path, i), ctx) for i, v in enumerate(node.value)]
        else:
            for key_node, value in node.value:
                if not isinstance(key_node, yaml.ScalarNode):
                    raise UnsafeYaml("non-scalar key")
                if key_node.tag == _MERGE:  # its mappings' pairs belong to this mapping
                    merged = value.value if isinstance(value, yaml.SequenceNode) else [value]
                    children.extend((m, path, ctx) for m in merged)
                    continue
                key = key_node.value
                children.append((value, (*path, key), _key(found, path, ctx, key, _texts(key_node))))
        stack.append(id(node))
        stack.extend(reversed(children))

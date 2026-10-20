"""What counts as a secret in the company repo, for everything the office shows a browser: secret-named keys, the
patterns of the secrets the office issues, a scrub and a final check."""

import re
from dataclasses import dataclass, field
from typing import Any

import yaml
from pydantic import BaseModel

SECRET_KEYS = frozenset({"devices", "password", "passwd", "password_hash", "token", "token_sha256", "secret",
                         "client_secret", "api_key", "apikey", "access_token", "refresh_token", "private_key"})
"""Keys whose values are secrets, as ``is_secret_key`` normalizes them."""

SECRET_SUFFIXES = ("_password", "_token", "_secret", "_api_key", "_private_key")
"""Endings that make a normalized key a secret key too."""

DEVICES = "devices"
"""Holds device names, which aren't secrets, beside each device's ``token_sha256``, which is."""

HIDDEN = "(hidden)"
"""What a scrubbed secret, or a commit subject or author that fails the check, becomes."""

SECRET_PATTERNS = (
    re.compile(r"act_[A-Za-z0-9_-]{43}"),  # a device token; no word boundaries, so a glued copy matches too
    re.compile(r"\$[a-z0-9-]+\$[^\s'\"]+"),  # a PHC string, as the schema's PasswordHash allows
)
"""Secrets with a known format, each replaced whole by ``scrub_text``."""

URL_CREDENTIALS = re.compile(r"(://[^\s/@:]*:)(?!\(hidden\)@)[^\s/@]+@")
"""The password in ``scheme://user:password@``; one already scrubbed doesn't match again."""

MIN_KNOWN = 8
"""Known secret values shorter than this are ignored by ``check_clean``, so they don't match everywhere."""

YAML_BUDGET = 100_000
"""The most values ``find_secrets`` visits, counting every alias reference: an alias bomb runs out of it."""


def is_secret_key(key: object) -> bool:
    """Whether ``key``, lowercased with ``-`` and spaces as ``_``, names a secret."""
    if not isinstance(key, str):
        return False
    norm = key.lower().replace("-", "_").replace(" ", "_")
    return norm in SECRET_KEYS or norm.endswith(SECRET_SUFFIXES)


def blank_secrets[M: BaseModel](model: M) -> M:
    """``model`` with every secret-named field (a person's devices and password hash) set to its default."""
    fields = type(model).model_fields
    return model.model_copy(update={name: info.get_default(call_default_factory=True)
                                    for name, info in fields.items() if is_secret_key(name)})


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
    """A YAML text couldn't be read safely: it doesn't parse, holds several documents, recurses or is too big."""


@dataclass
class YamlSecrets:
    """A parsed YAML text and its secrets."""

    data: Any
    keys: list[tuple[Any, ...]] = field(default_factory=list)
    """The path to each secret key not inside another secret key's value, in document order."""
    values: set[str] = field(default_factory=set)
    """Every string under a secret key, keys included; under ``devices``, only those under secret keys within."""


_PLAIN, _DEVICES, _SECRET = range(3)


def find_secrets(text: str) -> YamlSecrets:
    """Parse ``text`` with the pure-Python SafeLoader and collect its secret keys and values; ``UnsafeYaml`` on any
    failure, so callers can fail closed."""
    try:
        found = YamlSecrets(yaml.load(text, Loader=yaml.SafeLoader))  # pure Python, never the C loader
        _walk(found)
    except Exception as exc:  # YAMLError, RecursionError, a cycle, the budget: all mean "not safe"
        raise UnsafeYaml(type(exc).__name__) from None
    return found


def _walk(found: YamlSecrets) -> None:
    """Fill ``found.keys`` and ``found.values``, walking aliases each time they are referenced.

    ``on_path`` holds the containers on the current path, so a recursive anchor raises instead of looping.
    """
    stack: list[tuple[Any, tuple[Any, ...], int] | int] = [(found.data, (), _PLAIN)]
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
        if isinstance(node, str):
            if ctx == _SECRET:
                found.values.add(node)
            continue
        if not isinstance(node, (dict, list)):
            continue
        if id(node) in on_path:
            raise UnsafeYaml("recursive anchor")
        on_path.add(id(node))
        children: list[tuple[Any, tuple[Any, ...], int]] = []
        if isinstance(node, list):
            children = [(v, (*path, i), ctx) for i, v in enumerate(node)]
        else:
            for key, value in node.items():
                child = ctx
                if ctx == _SECRET:
                    children.append((key, (*path, key), _SECRET))
                elif is_secret_key(key):
                    if ctx == _PLAIN:
                        found.keys.append((*path, key))
                    child = _DEVICES if key.lower() == DEVICES else _SECRET
                children.append((value, (*path, key), child))
        stack.append(id(node))
        stack.extend(reversed(children))

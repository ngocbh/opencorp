"""Secret-named fields, which the company snapshot and ``GET /api/company`` leave out of the people they send."""

import re

from pydantic import BaseModel

_CAMEL = (re.compile(r"(?<=[A-Z])(?=[A-Z][a-z])"), re.compile(r"(?<=[a-z0-9])(?=[A-Z])"))
"""Word breaks in a camelCase or PascalCase key: an acronym before a word (``APIKey``), and a capital after a lowercase
letter or digit (``accessToken``). Lookarounds only, so a long run of capitals is read in linear time."""

SECRET_KEYS = frozenset({"devices", "password", "passwd", "password_hash", "token", "token_sha256", "secret",
                         "client_secret", "api_key", "apikey", "access_token", "refresh_token", "private_key"})
"""Keys whose values are secrets, as ``is_secret_key`` normalizes them."""

SECRET_SUFFIXES = ("_password", "_token", "_secret", "_api_key", "_private_key")
"""Endings that make a normalized key a secret key too."""


def key_name(key: str) -> str:
    """``key`` as the secret rules read it: camelCase words split by ``_``, lowercased, ``-``, ``.`` and spaces as
    ``_`` (so ``spring.datasource.password`` ends in ``_password``)."""
    for pattern in _CAMEL:
        key = pattern.sub("_", key)
    return key.lower().replace("-", "_").replace(".", "_").replace(" ", "_")


def is_secret_key(key: object) -> bool:
    """Whether ``key``, read by ``key_name`` (so ``accessToken`` is ``access_token``), names a secret."""
    if not isinstance(key, str):
        return False
    norm = key_name(key)
    return norm in SECRET_KEYS or norm.endswith(SECRET_SUFFIXES)


def blank_secrets[M: BaseModel](model: M) -> M:
    """``model`` with every secret-named field (a person's devices and password hash) set to its default."""
    secret = {name: info for name, info in type(model).model_fields.items() if is_secret_key(name)}
    # A required field has no default to blank it to; the schema must give secret fields one.
    assert not any(info.is_required() for info in secret.values()), f"a required secret field in {type(model)}"
    return model.model_copy(update={name: info.get_default(call_default_factory=True) for name, info in secret.items()})

"""The model provider runs use: ``office/provider.json``, read at each spawn."""

import fnmatch
import json
import re
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from agent_corp.secrets import read_private

_CREDENTIAL_NAMES = ("*_KEY", "*_APIKEY", "*_TOKEN", "*_SECRET", "*PASSWORD*", "*_PASS", "*_CREDENTIALS")
_VARIABLE = re.compile(r"^[A-Z_][A-Z0-9_]{0,63}$")
_USERINFO = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://[^/?#@]*@")  # scheme://user[:pass]@host


class ProviderError(Exception):
    """The provider file can't be used; the message says why."""


class Price(BaseModel):
    """USD per million tokens."""

    model_config = ConfigDict(extra="forbid")

    input: float = Field(ge=0)
    output: float = Field(ge=0)


class Provider(BaseModel):
    """What every run gets: composer's ``llm_config``, the worker's ``Job.env``, and model prices.

    The model key goes in ``llm_config["api_key"]``: it travels only in a worker's start
    frame and lives only in the worker's memory (composer keeps credential keys out of the
    run log and manifest). ``env`` is for settings that aren't secret (``VLLM_BASE_URL``,
    proxy and CA settings); it becomes the worker's ``os.environ``, which other processes of
    the same user can read, so a credential-like name is refused. ``llm_config`` None means
    composer's defaults (and its own auth store).
    """

    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    llm_config: dict[str, Any] | None = Field(default=None, repr=False)
    env: dict[str, str] = Field(default_factory=dict)
    prices: dict[str, Price] = Field(default_factory=dict)

    @field_validator("env")
    @classmethod
    def _no_credentials(cls, env: dict[str, str]) -> dict[str, str]:
        for name in env:
            if any(fnmatch.fnmatchcase(name.upper(), pattern) for pattern in _CREDENTIAL_NAMES):
                raise ValueError(f"{_shown(name)} looks like a credential; put the model key in llm_config.api_key")
        for name, value in env.items():
            if _USERINFO.match(value.strip()):
                raise ValueError(f"{_shown(name)} is a URL with credentials in it; keep credentials out of env "
                                 f"(the model key goes in llm_config.api_key)")
        return env


def load_provider[P: Provider](path: Path, model: type[P] = Provider, *, missing_ok: bool = True) -> P:
    """The provider in ``path``, validated as ``model``; ``model()`` when there is no file and ``missing_ok``.

    The file holds the model key, so it must be a regular file private to its owner.

    Raises:
        FileNotFoundError: there is no file, and not ``missing_ok``.
        ProviderError: the file is a symlink, readable by others, or not a valid provider.
    """
    try:
        data = read_private(path)
    except FileNotFoundError:
        if missing_ok:
            return model()
        raise
    except PermissionError as exc:
        raise ProviderError(str(exc)) from None
    try:
        return model.model_validate(json.loads(data))
    except (ValueError, ValidationError) as exc:
        # Never echo the file: it holds keys. Errors leave out input values, extra field
        # names, model names, and env names that aren't variable names, since a key
        # pasted there would be one.
        detail = validation_errors(exc) if isinstance(exc, ValidationError) else "not valid JSON"
        raise ProviderError(f"{path}: {detail}") from None


def _shown(name: str) -> str:
    """An env name as errors show it: an upper-case variable name, or a placeholder."""
    return name if _VARIABLE.match(name) else "an env name"


def validation_errors(exc: ValidationError) -> str:
    """The validation errors, naming only fields the provider defines and env variable names."""
    lines = []
    for error in exc.errors(include_url=False, include_input=False, include_context=False):
        loc = [str(p) for p in error["loc"]]
        if len(loc) > 1 and loc[0] == "env":
            loc[1] = _shown(loc[1])
        if len(loc) > 1 and loc[0] == "prices":
            loc[1] = "a model"
        if error["type"] == "extra_forbidden":
            loc[-1] = "an extra field"
        lines.append(f"{'.'.join(loc) or 'provider'}: {error['msg']}")
    return "; ".join(lines)

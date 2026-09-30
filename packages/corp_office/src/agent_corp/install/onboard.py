"""``ac onboard``: the office home, the company repo, the model provider, the service, and a first agent."""

import getpass
import json
import os
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Protocol, TextIO

from agent_composer.llm_clients.config import SUPPORTED_LLM_PROVIDERS, LLMConfig
from pydantic import ValidationError

from agent_corp.chat.provider import Provider, ProviderError, _errors, load_provider


class OnboardError(Exception):
    """Onboarding stopped; the message says why and what to do. It never contains a key."""


class Prompter(Protocol):
    """How onboarding talks to the owner."""

    def ask(self, question: str, default: str = "") -> str:
        """An answer, or ``default`` for an empty one."""

    def secret(self, question: str) -> str:
        """An answer read without echo."""

    def say(self, text: str) -> None:
        """Tell the owner something."""


class TtyPrompter:
    """Asks on the terminal; a secret is read with ``getpass``, so it is never echoed.

    ``preset`` answers questions by their text without asking (from command-line flags);
    with ``interactive`` False, every other question takes its default.
    """

    def __init__(self, preset: Mapping[str, str] | None = None, interactive: bool = True) -> None:
        self.preset = {k: v for k, v in (preset or {}).items() if v}
        self.interactive = interactive

    def ask(self, question: str, default: str = "") -> str:
        if question in self.preset:
            return self.preset[question]
        if not self.interactive:
            return default
        shown = f"{question} [{default}]: " if default else f"{question}: "
        try:
            return input(shown).strip() or default
        except EOFError:
            raise OnboardError(f"no answer to {question!r} (stdin closed)") from None

    def secret(self, question: str) -> str:
        if not self.interactive or not sys.stdin.isatty():
            # getpass falls back to reading stdin with echo when there is no terminal.
            raise OnboardError("there is no terminal to read the key without echo;"
                               " pass the provider with --provider-stdin instead")
        return getpass.getpass(f"{question}: ").strip()

    def say(self, text: str) -> None:
        print(text, flush=True)


def _llm_errors(exc: ValidationError) -> str:
    """The ``llm_config`` errors, naming only fields composer defines (a key pasted as a field name stays out)."""
    lines = []
    for error in exc.errors(include_url=False, include_input=False, include_context=False):
        loc = [str(p) for p in error["loc"]]
        if error["type"] == "extra_forbidden" or (loc and loc[0] not in LLMConfig.model_fields):
            lines.append(f"llm_config has an extra field; the fields are {', '.join(LLMConfig.model_fields)}")
        else:
            lines.append(f"{'.'.join(['llm_config', *loc])}: {error['msg']}")
    return "; ".join(dict.fromkeys(lines))


def check_provider(data: object) -> Provider:
    """``data`` as a provider whose ``llm_config`` composer accepts; errors never include values."""
    try:
        provider = Provider.model_validate(data)
    except ValidationError as exc:
        raise OnboardError(f"the provider isn't valid: {_errors(exc)}") from None
    llm = provider.llm_config or {}
    try:
        LLMConfig.model_validate(llm)
    except ValidationError as exc:
        raise OnboardError(f"composer won't take this provider: {_llm_errors(exc)}") from None
    if "api_key" in llm and not llm.get("provider"):
        # Composer refuses a key without a provider at run time; say so now.
        raise OnboardError("llm_config.api_key needs llm_config.provider, so the key goes only to that provider")
    return provider


def _ask_provider(prompter: Prompter) -> dict:
    choices = ", ".join(SUPPORTED_LLM_PROVIDERS)
    while (name := prompter.ask("Model provider", "anthropic")) not in SUPPORTED_LLM_PROVIDERS:
        prompter.say(f"Choose one of: {choices}")
    llm = {"provider": name}
    if model := prompter.ask("Model (empty for the provider's default)"):
        llm["model"] = model
    if key := prompter.secret(f"{name} API key (empty to use `composer auth {name}`; not shown)"):
        llm["api_key"] = key
    else:
        prompter.say(f"No key saved; runs will use composer's own login (`composer auth {name}`).")
    return {"llm_config": llm}


def write_private(path: Path, data: bytes) -> None:
    """Replace ``path`` with ``data`` as a 0600 file, atomically; a symlink at ``path`` is replaced, not followed."""
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.unlink(missing_ok=True)  # left by a crashed run with the same pid
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def ensure_provider(path: Path, prompter: Prompter, stdin: TextIO | None = None) -> bool:
    """Make sure ``path`` holds a usable provider; return whether it was written.

    An existing file is checked and kept. Otherwise the provider comes from ``stdin`` (JSON)
    when given, else from the owner, the key read without echo. It never goes through argv
    or the environment.

    Raises:
        OnboardError: the provider isn't usable; the message never contains the key.
    """
    if os.path.lexists(path):
        again = "fix it or remove it and run `ac onboard` again"
        try:
            check_provider(load_provider(path).model_dump(exclude_defaults=True))
        except ProviderError as exc:  # its message names the file
            raise OnboardError(f"{exc}; {again}") from None
        except OnboardError as exc:
            raise OnboardError(f"{path}: {exc}; {again}") from None
        return False
    if stdin is not None:
        try:
            data = json.loads(stdin.read())
        except ValueError:
            raise OnboardError("the provider on stdin is not valid JSON") from None
    else:
        data = _ask_provider(prompter)
    provider = check_provider(data)
    write_private(path, (json.dumps(provider.model_dump(exclude_defaults=True), indent=2) + "\n").encode())
    try:
        load_provider(path)
    except ProviderError as exc:
        raise OnboardError(str(exc)) from None
    return True

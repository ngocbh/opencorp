"""``ac onboard``: the office home, the company repo, the model provider, the service, and a first agent."""

import getpass
import json
import os
import pwd
import re
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Protocol, TextIO

import httpx
from agent_composer.llm_clients.config import SUPPORTED_LLM_PROVIDERS, LLMConfig
from pydantic import ValidationError

from agent_corp.chat.provider import Provider, ProviderError, load_provider, validation_errors
from agent_corp.company.lint import lint
from agent_corp.company.loader import load_repo
from agent_corp.company_template import Owner, is_new, template_files, write_company
from agent_corp.daemon.app import OfficePaths
from agent_corp.daemon.main import OfficeStartError, make_office_dir
from agent_corp.install import service
from agent_corp.install.launch import REPO, Host, ServiceError, launch

FIRST_AGENT = ("Minh", "Engineer")
"""The first agent's default name, and its title."""


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
        raise OnboardError(f"the provider isn't valid: {validation_errors(exc)}") from None
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


def _slug(text: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]", "-", text.lower())).strip("-")[:32].strip("-")


def owner_defaults(login: str, gecos: str) -> tuple[str, str]:
    """The owner's default name and handle: the account's full name and a slug of the login."""
    return gecos.split(",")[0].strip() or login, _slug(login) or "owner"


def _ask_company(prompter: Prompter) -> tuple[str, Owner]:
    login = pwd.getpwuid(os.getuid())
    name, handle = owner_defaults(login.pw_name, login.pw_gecos)
    while True:
        company = prompter.ask("Company name", "My company")
        who = prompter.ask("Your name", name)
        slug = prompter.ask("Your handle", handle)
        owner = Owner(id=slug, handle=slug, name=who)
        try:
            template_files(company, owner)  # validates without writing
            return company, owner
        except ValueError as exc:
            prompter.say(f"That doesn't work: {exc}")


def _hire_first(socket: Path, ceo: str, prompter: Prompter) -> str:
    """Hire the first agent through the office (preview, then confirm), reporting to the CEO."""
    name = prompter.ask("Name your first agent", FIRST_AGENT[0])
    handle = prompter.ask("Their handle", _slug(name) or "agent")
    body = {"name": name, "handle": handle, "title": FIRST_AGENT[1], "manager": ceo}
    with httpx.Client(transport=httpx.HTTPTransport(uds=str(socket)), base_url="http://office",
                      timeout=30) as client:
        preview = client.post("/people", json=body)
        if preview.status_code != 200:
            raise OnboardError(f"the office refused the hire: {preview.status_code} {preview.text}")
        errors = [i["message"] for i in preview.json()["issues"] if i["severity"] == "error"]
        if errors:
            raise OnboardError("the hire doesn't lint: " + "; ".join(errors))
        done = client.post("/people", json=body | {"id": preview.json()["person"]["id"], "confirm": True})
        if done.status_code != 200:
            raise OnboardError(f"the office refused the hire: {done.status_code} {done.text}")
    return f"{name} (@{handle})"


def onboard(home: Path, prompter: Prompter, *, mode: str = "auto", stdin: TextIO | None = None,
            host: Host | None = None, repo: Path = REPO, environ: Mapping[str, str] = os.environ,
            hire: bool = True) -> None:
    """Set up the office at ``home``; running it again only fills in what is missing.

    In order: the home and office dirs (0700), the company repo from the template (lint
    errors stop here), ``office/provider.json``, the daemon under ``mode``, and, once the
    office answers, a first agent if ``hire`` and the company has none.

    Raises:
        OnboardError: a step failed; earlier steps stay done.
    """
    host = host or Host()
    run = launch(home, repo=repo, environ=environ, user_home=host.user_home)
    paths = OfficePaths(run.home)
    try:
        paths.home.mkdir(mode=0o700, parents=True, exist_ok=True)
        # mkdir leaves an existing home's mode alone; the home holds the company and the office.
        os.chmod(paths.home, 0o700)
        make_office_dir(paths.office)
    except OSError as exc:
        raise OnboardError(f"can't set up the office home {paths.home}: {exc.strerror or exc}") from None
    except OfficeStartError as exc:
        raise OnboardError(str(exc)) from None
    prompter.say(f"Office home: {paths.home}")

    new = is_new(paths.company)
    company, owner = _ask_company(prompter) if new else (None, None)
    written = write_company(paths.company, paths.worktrees, company=company, owner=owner)
    done = "created at" if new else f"added {len(written)} template files to" if written else "up to date at"
    prompter.say(f"Company repo: {done} {paths.company}")
    repo_now = load_repo(paths.company)
    errors = [i for i in lint(repo_now) if i.severity == "error"]
    if errors:
        raise OnboardError("the company repo has errors; fix them and run `ac onboard` again:\n"
                           + "\n".join(f"  {i.path}: {i.code}: {i.message}" for i in errors))

    wrote = ensure_provider(paths.office / "provider.json", prompter, stdin)
    prompter.say(f"Model provider: {'saved to' if wrote else 'up to date at'} {paths.office / 'provider.json'}")

    try:
        installed = service.install(run, host, mode)
        for note in installed.notes:
            prompter.say(f"  skipped {note}")
        service.wait(run, host)
    except (ServiceError, OfficeStartError) as exc:
        raise OnboardError(str(exc)) from None
    prompter.say(f"Office: running under {installed.mode or 'a process started by hand'}; log at {run.log}")

    if hire and not any(p.kind == "agent" for p in repo_now.people.values()):
        prompter.say(f"First agent: hired {_hire_first(run.socket, repo_now.company.ceo, prompter)}")
    prompter.say("Done. Run `ac` in a project folder to talk to your team.")

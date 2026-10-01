"""``ac onboard``: the office home, the company repo, the model provider, the service, and a first agent."""

import getpass
import json
import os
import pwd
import re
import sys
from collections.abc import Mapping
from dataclasses import replace
from pathlib import Path
from typing import Annotated, Protocol, TextIO

import httpx
from agent_composer.llm_clients.config import SUPPORTED_LLM_PROVIDERS, LLMConfig
from pydantic import TypeAdapter, ValidationError

from agent_corp.auth.identity import Identity, device_name, identity_path, read_identity, write_identity
from agent_corp.auth.tokens import new_token, token_sha256
from agent_corp.chat.provider import Provider, ProviderError, load_provider, validation_errors
from agent_corp.company.git import CompanyGitError
from agent_corp.company.lint import lint
from agent_corp.company.loader import load_repo
from agent_corp.company_template import Owner, is_new, missing_files, template_files, write_company
from agent_corp.daemon.app import OfficePaths
from agent_corp.daemon.main import OfficeStartError, make_office_dir
from agent_corp.install import service
from agent_corp.install.launch import REPO, Host, ServiceError, launch
from agent_corp.protocol.models import Device, HireRequest, HireResponse
from agent_corp.secrets import write_private

FIRST_AGENT = ("Minh", "Engineer")
"""The first agent's default name, and its title."""


def stop_to_top_up(count: int) -> str:
    """What to do about ``count`` missing template files while the office runs."""
    files = "template file" if count == 1 else "template files"
    return f"The office is running; stop it and run `ac onboard` again to add {count} {files}."


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

    def step(self, number: int, total: int, title: str, why: str) -> None:
        """Start step ``number`` of ``total``: show ``step_lines``."""


def step_lines(number: int, total: int, title: str, why: str) -> list[str]:
    """A step as shown: a header such as ``Step 2 of 5: You``, then one line on why it matters."""
    return [f"Step {number} of {total}: {title}", why]


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

    def step(self, number: int, total: int, title: str, why: str) -> None:
        print("\n" + "\n".join(step_lines(number, total, title, why)), flush=True)


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


def ensure_provider(path: Path, prompter: Prompter, stdin: TextIO | None = None) -> bool:
    """Make sure ``path`` holds a usable provider; return whether it was written.

    A provider on ``stdin`` (JSON) is checked and replaces the file, so a key can be
    rotated. Without one, an existing file is checked and kept, and a missing one is asked
    of the owner, the key read without echo. The key never goes through argv or the
    environment.

    Raises:
        OnboardError: the provider isn't usable; the message never contains the key. An
            existing file is left as it was.
    """
    if stdin is not None:
        try:
            data = json.loads(stdin.read())
        except ValueError:
            raise OnboardError("the provider on stdin is not valid JSON") from None
    elif os.path.lexists(path):
        again = "fix it or remove it and run `ac onboard` again"
        try:
            check_provider(load_provider(path).model_dump(exclude_defaults=True))
        except ProviderError as exc:  # its message names the file
            raise OnboardError(f"{exc}; {again}") from None
        except OnboardError as exc:
            raise OnboardError(f"{path}: {exc}; {again}") from None
        return False
    else:
        data = _ask_provider(prompter)
    provider = check_provider(data)
    try:
        write_private(path, (json.dumps(provider.model_dump(exclude_defaults=True), indent=2) + "\n").encode())
    except OSError as exc:
        raise OnboardError(f"can't write {path}: {exc.strerror or exc}") from None
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
    try:
        login = pwd.getpwuid(os.getuid())
    except KeyError:
        raise OnboardError(f"user id {os.getuid()} has no account in the password database") from None
    name, handle = owner_defaults(login.pw_name, login.pw_gecos)
    while True:
        company = prompter.ask("Company name", "My company")
        who = prompter.ask("Your name", name)
        slug = prompter.ask("Your handle", handle)
        owner = Owner(handle=slug, name=who)
        try:
            template_files(company, owner)  # validates without writing
            return company, owner
        except ValueError as exc:
            prompter.say(f"That doesn't work: {exc}")


_HANDLE = TypeAdapter(Annotated[str, *HireRequest.model_fields["handle"].metadata])


def handle_problem(handle: str) -> str | None:
    """Why ``handle`` can't be a person's handle, or None if it can."""
    try:
        _HANDLE.validate_python(handle)
    except ValidationError as exc:
        return exc.errors(include_url=False)[0]["msg"]
    return None


def _hire_first(socket: Path, ceo: str, prompter: Prompter, transport: httpx.BaseTransport | None = None,
                identity: Identity | None = None) -> str:
    """Hire the first agent through the office (preview, then confirm), reporting to the CEO, as ``identity``."""
    name = prompter.ask("Name your first agent", FIRST_AGENT[0])
    while (problem := handle_problem(handle := prompter.ask("Their handle", _slug(name) or "agent"))) is not None:
        prompter.say(f"That doesn't work: {problem}")
    body = {"name": name, "handle": handle, "title": FIRST_AGENT[1], "manager": ceo}
    again = "run `ac onboard` again to retry"
    try:
        with httpx.Client(transport=transport or httpx.HTTPTransport(uds=str(socket)), base_url="http://office",
                          timeout=30, headers=identity.headers() if identity else None) as client:
            preview = client.post("/people", json=body)
            if preview.status_code == 401:
                raise OnboardError("the office doesn't know this device; run `ac login`, then `ac onboard` again")
            if preview.status_code != 200:
                raise OnboardError(f"the office refused the hire: {preview.status_code} {preview.text}")
            errors = [i.message for i in HireResponse.model_validate(preview.json()).issues if i.severity == "error"]
            if errors:
                raise OnboardError("the hire doesn't lint: " + "; ".join(errors))
            done = client.post("/people", json=body | {"confirm": True})
            if done.status_code != 200:
                raise OnboardError(f"the office refused the hire: {done.status_code} {done.text}")
    except httpx.HTTPError as exc:
        raise OnboardError(f"couldn't hire the first agent: the office didn't answer ({exc}); {again}") from None
    except (KeyError, TypeError, ValueError):
        raise OnboardError("couldn't hire the first agent: the office's answer isn't a hire preview;"
                           f" {again}") from None
    return f"{name} (@{handle})"


def _make_device(home: Path, owner: Owner) -> Owner:
    """Make this device's token for ``owner`` and save the identity; ``owner`` listing the device.

    The identity is written before the company, so the device the first commit lists always
    has its token here. A new company replaces an identity from an earlier one.

    Raises:
        OnboardError: the identity file can't be written.
    """
    me = Identity(owner.handle, device_name(), new_token())
    try:
        write_identity(identity_path(home), me)
    except OSError as exc:
        raise OnboardError(f"can't write {identity_path(home)}: {exc.strerror or exc}") from None
    return replace(owner, devices=(Device(name=me.device, token_sha256=token_sha256(me.token)),))


def onboard(home: Path, prompter: Prompter, *, mode: str = "auto", stdin: TextIO | None = None,
            host: Host | None = None, repo: Path = REPO, environ: Mapping[str, str] = os.environ,
            hire: bool = True, device: bool = True) -> None:
    """Set up the office at ``home``; running it again only fills in what is missing.

    In order: the home and office dirs (0700), for a new company and if ``device`` this
    device's identity (the owner's token in ``identity.json``, its hash in the owner's
    first ``person.yaml``), the company repo from the template (lint errors stop here; left
    alone while the office runs), ``office/provider.json``, the daemon under ``mode``, and,
    once the office answers, a first agent if ``hire`` and the company has none.

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

    # A running office is the only writer of its company clone (CompanyGit's lock is
    # in-process), so the template top-up waits until it is stopped.
    running = host.answers(run.socket)
    try:
        new = is_new(paths.company)
        if running and new:
            raise OnboardError(f"the office is running, but {paths.company} has no company yet;"
                               " stop it and run `ac onboard` again")
        if running:
            written, missing = [], missing_files(paths.company)
        else:
            company, owner = _ask_company(prompter) if new else (None, None)
            if owner is not None and device:
                owner = _make_device(paths.home, owner)
            written, missing = write_company(paths.company, paths.worktrees, company=company, owner=owner), []
    except (CompanyGitError, OSError, ValueError) as exc:
        raise OnboardError(f"can't write the company repo at {paths.company}: {exc}") from None
    if missing:
        prompter.say(f"Company repo: {paths.company}. {stop_to_top_up(len(missing))}")
    else:
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

    me = read_identity(identity_path(paths.home))
    if new and owner is not None and owner.devices:
        prompter.say(f"This device: {owner.devices[0].name}, acting as @{owner.handle}"
                     f" (its token is in {identity_path(paths.home)})")
    if hire and not any(p.kind == "agent" for p in repo_now.people.values()):
        prompter.say(f"First agent: hired {_hire_first(run.socket, repo_now.company.ceo, prompter, identity=me)}")
    if me is None and not new:
        prompter.say("This device has no identity yet; run `ac login` to use ac from it.")
    prompter.say("Done. Run `ac` in a project folder to talk to your team.")

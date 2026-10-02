"""``ac onboard``: this machine's office for a company: the home, the company repo, this device, the model, the service."""

import getpass
import json
import os
import pwd
import re
import shutil
import subprocess
import sys
from collections.abc import Callable, Mapping
from dataclasses import replace
from pathlib import Path
from typing import Annotated, Protocol, TextIO

from agent_composer.llm_clients.config import SUPPORTED_LLM_PROVIDERS, LLMConfig
from pydantic import TypeAdapter, ValidationError

from agent_corp.auth.devices import DeviceRefused, add_device
from agent_corp.auth.identity import Identity, device_name, identity_path, read_identity, write_identity
from agent_corp.auth.tokens import new_token, token_sha256
from agent_corp.chat.provider import Provider, ProviderError, load_provider, validation_errors
from agent_corp.company.git import CompanyGit, CompanyGitError
from agent_corp.company.lint import lint
from agent_corp.company.loader import load_repo
from agent_corp.company_template import Owner, is_new, missing_files, write_company
from agent_corp.daemon.app import OfficePaths
from agent_corp.daemon.main import OfficeStartError, make_office_dir
from agent_corp.install import service
from agent_corp.install.launch import REPO, Host, ServiceError, launch
from agent_corp.protocol.models import Device, HireRequest
from agent_corp.secrets import write_private


SET_UP = "run `ac init` to create one, or `ac onboard --from URL` to join one"
"""What to do when a home has no company."""


def stop_to_top_up(count: int) -> str:
    """What to do about ``count`` missing template files while the office runs."""
    files = "template file" if count == 1 else "template files"
    return f"The office is running; stop it and run `ac onboard` again to add {count} {files}."


class OnboardError(Exception):
    """Onboarding stopped; the message says why and what to do. It never contains a key."""


class NoTerminal(OnboardError):
    """A secret was asked for, but there's no terminal to read it from without echo."""


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
            raise NoTerminal(f"there is no terminal to read {question!r} without echo")
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
    try:
        key = prompter.secret(f"{name} API key (empty to use `composer auth {name}`; not shown)")
    except NoTerminal:
        raise OnboardError("there is no terminal to read the key without echo;"
                           " pass the provider with --provider-stdin instead") from None
    if key:
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


def slug(text: str) -> str:
    """``text`` as a handle: lowercase letters, digits and single '-', at most 32 characters."""
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]", "-", text.lower())).strip("-")[:32].strip("-")


def owner_defaults(login: str, gecos: str) -> tuple[str, str]:
    """The owner's default name and handle: the account's full name and a slug of the login."""
    return gecos.split(",")[0].strip() or login, slug(login) or "owner"


def login_defaults() -> tuple[str, str]:
    """``owner_defaults`` for the account running this.

    Raises:
        OnboardError: the user id has no account.
    """
    try:
        login = pwd.getpwuid(os.getuid())
    except KeyError:
        raise OnboardError(f"user id {os.getuid()} has no account in the password database") from None
    return owner_defaults(login.pw_name, login.pw_gecos)


_HANDLE = TypeAdapter(Annotated[str, *HireRequest.model_fields["handle"].metadata])


def handle_problem(handle: str) -> str | None:
    """Why ``handle`` can't be a person's handle, or None if it can."""
    try:
        _HANDLE.validate_python(handle)
    except ValidationError as exc:
        return exc.errors(include_url=False)[0]["msg"]
    return None


TRIES = 5
"""How many answers a question takes before giving up: a preset or a default comes back the same each time."""


def ask_until(prompter: Prompter, question: str, default: str, problem: Callable[[str], str | None]) -> str:
    """Ask ``question`` until ``problem`` finds nothing wrong with the answer, at most ``TRIES`` times.

    Raises:
        OnboardError: no answer worked.
    """
    for _ in range(TRIES):
        answer = prompter.ask(question, default)
        if (why := problem(answer)) is None:
            return answer
        prompter.say(f"That doesn't work: {why}")
    raise OnboardError(f"no usable answer to {question!r}")


def make_device(home: Path, owner: Owner) -> Owner:
    """Make this device's token for ``owner`` and save the identity; ``owner`` listing the device.

    The identity is written before the company, so the device the first commit lists always
    has its token here. A new company replaces an identity from an earlier one.

    Raises:
        OnboardError: the identity file can't be written.
    """
    me = Identity(owner.handle, device_name(), new_token())
    _save_identity(home, me)
    return replace(owner, devices=(Device(name=me.device, token_sha256=token_sha256(me.token)),))


def _save_identity(home: Path, me: Identity) -> None:
    try:
        write_identity(identity_path(home), me)
    except OSError as exc:
        raise OnboardError(f"can't write {identity_path(home)}: {exc.strerror or exc}") from None


def make_home(paths: OfficePaths) -> None:
    """Make the home and office dirs, both 0700.

    Raises:
        OnboardError: they can't be made, or the office dir isn't this user's.
    """
    try:
        paths.home.mkdir(mode=0o700, parents=True, exist_ok=True)
        # mkdir leaves an existing home's mode alone; the home holds the company and the office.
        os.chmod(paths.home, 0o700)
        make_office_dir(paths.office)
    except OSError as exc:
        raise OnboardError(f"can't set up the office home {paths.home}: {exc.strerror or exc}") from None
    except OfficeStartError as exc:
        raise OnboardError(str(exc)) from None


_USERINFO = re.compile(r"(?<=://)[^/@\s]+@")


def redact(text: str) -> str:
    """``text`` with the user and password taken out of any URL in it, since a remote URL can carry a token."""
    return _USERINFO.sub("***@", text)


def user_git(*args: str) -> subprocess.CompletedProcess[str]:
    """Run git as the user would, so their credentials and ssh setup reach a remote; never raises."""
    try:
        return subprocess.run(["git", *args], capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=300)
    except OSError as exc:
        return subprocess.CompletedProcess(args, 127, "", f"can't run git: {exc.strerror or exc}")
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(args, 124, "", "git timed out")


CLONE = ".company-clone"
"""Where onboarding clones a company before this device is added to it; renamed to ``company`` once done, so
a stopped onboarding leaves no company that lacks this device."""

REPO_URL = "Company repo URL (empty if there's none yet)"
WHO = "Which of them are you?"
"""The questions, by which command-line flags preset their answers."""


def remove_path(path: Path) -> None:
    """Remove ``path``, whether a dir, a file, or a symlink (never what it points to); nothing if it's gone."""
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def _clone(url: str, dest: Path) -> None:
    """Clone the company at ``url`` into ``dest``, replacing what an earlier, stopped clone left there.

    Raises:
        OnboardError: the clone failed, or isn't a company; nothing is left at ``dest``.
    """
    remove_path(dest)
    done = user_git("clone", "-q", "--", url, str(dest))
    if done.returncode != 0:
        remove_path(dest)
        raise OnboardError(f"can't clone {redact(url)}: {redact(done.stderr.strip())}")
    if is_new(dest):
        remove_path(dest)
        raise OnboardError(f"{redact(url)} isn't a company repo: it has no company.yaml at its top")


def _login_handle() -> str:
    try:
        return login_defaults()[1]
    except OnboardError:
        return ""


def _join(root: Path, worktrees: Path, home: Path, prompter: Prompter) -> Identity:
    """Ask which of the company's humans this device acts as, list it in their ``person.yaml`` and commit that.

    The default is the human whose handle is this login's, otherwise the only human. A device name the
    human already lists gets a ``-2`` (``-3``, ...) suffix.

    Raises:
        OnboardError: there's no human, no answer names one, or the device can't be added.
    """
    people = load_repo(root).people
    humans = sorted(h for h, p in people.items() if p.kind == "human")
    if not humans:
        raise OnboardError("the company has no humans for this device to act as")
    login = _login_handle()
    default = login if login in humans else humans[0] if len(humans) == 1 else ""
    prompter.say(f"The company's humans: {', '.join('@' + h for h in humans)}")
    handle = ask_until(prompter, WHO, default, lambda h: None if h in humans else
                       f"@{h} isn't one of them" if h else "say which one you are")
    taken = {d.name for d in people[handle].devices}
    name = base = device_name()
    suffix = 2
    while name in taken:
        name, suffix = f"{base[:60]}-{suffix}", suffix + 1
    me = Identity(handle, name, new_token())
    try:
        add_device(CompanyGit(root, worktrees), handle, Device(name=name, token_sha256=token_sha256(me.token)), handle)
    except (DeviceRefused, CompanyGitError, OSError) as exc:
        raise OnboardError(f"can't add this device to @{handle}: {exc}") from None
    _save_identity(home, me)
    return me


STEPS = 4
"""Onboarding's steps: the company, this device, the model, and the office."""


def onboard(home: Path, prompter: Prompter, *, mode: str = "auto", stdin: TextIO | None = None,
            host: Host | None = None, repo: Path = REPO, environ: Mapping[str, str] = os.environ,
            source: str | None = None, steps: bool = True) -> None:
    """Set up this machine's office for the company at ``home``; running it again only fills in what is missing.

    In order: the home and office dirs (0700); the company repo, cloned from ``source`` (or a
    URL asked for) when there's none here, and topped up with any template files it lacks
    (lint errors stop here; left alone while the office runs); this device, which for a
    cloned company is listed for the human you pick and committed in the clone before the
    office starts; ``office/provider.json``; and the daemon under ``mode``. With ``steps``,
    each step gets a numbered header (``ac init`` turns them off, since onboarding is one of
    its steps).

    Raises:
        OnboardError: a step failed, or there's no company here and no repo to clone;
            earlier steps stay done.
    """
    host = host or Host()
    run = launch(home, repo=repo, environ=environ, user_home=host.user_home)
    paths = OfficePaths(run.home)
    make_home(paths)
    prompter.say(f"Office home: {paths.home}")

    def step(number: int, title: str, why: str) -> None:
        if steps:
            prompter.step(number, STEPS, title, why)

    step(1, "Company", "This office works for one company, whose people and flows live in its git repo.")
    # A running office is the only writer of its company clone (CompanyGit's lock is
    # in-process), so the template top-up waits until it is stopped.
    running = host.answers(run.socket)
    new = is_new(paths.company)
    root = paths.company
    if new:
        if running:
            raise OnboardError(f"the office is running, but {paths.company} has no company yet;"
                               " stop it and run `ac onboard` again")
        if paths.company.is_dir() and any(paths.company.iterdir()):
            raise OnboardError(f"{paths.company} holds a company that was never finished (no first commit);"
                               " run `ac init` to finish it, or remove it to join another")
        url = source or prompter.ask(REPO_URL)
        if not url:
            raise OnboardError(f"there's no company at {paths.company}; {SET_UP}")
        root = paths.home / CLONE
        _clone(url, root)
        prompter.say(f"Company repo: cloned {redact(url)}")
    try:
        try:
            written, missing = ([], missing_files(root)) if running else (write_company(root, paths.worktrees), [])
        except (CompanyGitError, OSError, ValueError) as exc:
            raise OnboardError(f"can't write the company repo at {paths.company}: {exc}") from None
        if missing:
            prompter.say(f"Company repo: {paths.company}. {stop_to_top_up(len(missing))}")
        elif written or not new:
            done = f"added {len(written)} template files to" if written else "up to date at"
            prompter.say(f"Company repo: {done} {paths.company}")
        errors = [i for i in lint(load_repo(root)) if i.severity == "error"]
        if errors:
            raise OnboardError("the company repo has errors; fix them and run `ac onboard` again:\n"
                               + "\n".join(f"  {i.path}: {i.code}: {i.message}" for i in errors))

        step(2, "This device", "The office takes requests only from devices its humans list, once any human"
                               " lists one.")
        me = _join(root, paths.worktrees, paths.home, prompter) if new else read_identity(identity_path(paths.home))
        if new:
            if paths.company.is_dir():  # an empty dir; os.replace can't put a directory over a full one
                paths.company.rmdir()
            os.replace(root, paths.company)
    except BaseException:
        if new:
            remove_path(root)
        raise
    if me is not None:
        prompter.say(f"This device: {me.device}, acting as @{me.handle} (its token is in {identity_path(paths.home)})")
    else:
        prompter.say("This device has no identity yet; run `ac login` to use ac from it.")

    step(3, "Model", "Your agents think with this model; its key stays in this office, readable only by you.")
    wrote = ensure_provider(paths.office / "provider.json", prompter, stdin)
    prompter.say(f"Model provider: {'saved to' if wrote else 'up to date at'} {paths.office / 'provider.json'}")

    step(4, "Office", "The office runs as a service, so your agents keep working after this terminal closes.")
    try:
        installed = service.install(run, host, mode)
        for note in installed.notes:
            prompter.say(f"  skipped {note}")
        service.wait(run, host)
    except (ServiceError, OfficeStartError) as exc:
        raise OnboardError(str(exc)) from None
    prompter.say(f"Office: running under {installed.mode or 'a process started by hand'}; log at {run.log}")
    prompter.say("Done. Run `ac` in a project folder to talk to your team.")

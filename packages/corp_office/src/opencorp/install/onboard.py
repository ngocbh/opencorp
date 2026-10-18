"""``opencorp onboard``: this machine's office for a company: the home, the company repo, this device, the model, the service."""

import getpass
import json
import os
import pwd
import re
import shutil
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import replace
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol, TextIO

from yian.llm_clients.config import SUPPORTED_LLM_PROVIDERS, LLMConfig
from pydantic import ValidationError

from opencorp.auth.devices import DeviceRefused, add_device
from opencorp.auth.identity import Identity, device_name, identity_path, read_identity, write_identity
from opencorp.auth.passwords import check_password
from opencorp.auth.tokens import new_token, token_sha256
from opencorp.chat import models
from opencorp.chat.connections import azure_base_url
from opencorp.chat.provider import Provider, ProviderError, load_provider, validation_errors
from opencorp.company.git import CompanyGit, CompanyGitError
from opencorp.company.lint import lint
from opencorp.company.loader import load_repo
from opencorp.company_template import Owner, is_new, missing_files, write_company
from opencorp.daemon.app import OfficePaths
from opencorp.daemon.main import OfficeStartError, make_office_dir
from opencorp.install import service
from opencorp.install.launch import REPO, Host, ServiceError, launch
from opencorp.protocol.models import Device
from opencorp.secrets import write_private

if TYPE_CHECKING:
    from prompt_toolkit.input import Input
    from prompt_toolkit.output import Output


SET_UP = "run `opencorp init` to create one, or `opencorp onboard --from URL` to join one"
"""What to do when a home has no company."""


def stop_to_top_up(count: int) -> str:
    """What to do about ``count`` missing template files while the office runs."""
    files = "template file" if count == 1 else "template files"
    return f"The office is running; stop it and run `opencorp onboard` again to add {count} {files}."


class OnboardError(Exception):
    """Onboarding stopped; the message says why and what to do. It never contains a key."""


class NoTerminal(OnboardError):
    """A secret was asked for, but there's no terminal to read it from without echo."""


class Prompter(Protocol):
    """How onboarding talks to the owner."""

    interactive: bool
    """Whether there's someone at a terminal to ask; without one, questions take their defaults and secrets raise
    ``NoTerminal``."""

    def ask(self, question: str, default: str = "") -> str:
        """An answer, or ``default`` for an empty one."""

    def choose(self, question: str, options: Sequence[str], default: str = "", typed: bool = False) -> str:
        """One of ``options``, picked by the owner, or with ``typed`` an answer they type instead; ``default`` (an
        option, or with ``typed`` any text) for an empty answer or when there's no one to ask."""

    def secret(self, question: str) -> str:
        """An answer read without echo."""

    def say(self, text: str) -> None:
        """Tell the owner something."""

    def step(self, number: int, total: int, title: str, why: str) -> None:
        """Start step ``number`` of ``total``: show ``step_lines``."""


def step_lines(number: int, total: int, title: str, why: str) -> list[str]:
    """A step as shown: a header such as ``Step 2 of 5: You``, then one line on why it matters."""
    return [f"Step {number} of {total}: {title}", why]


STYLE = [("qmark", "fg:ansicyan bold"), ("question", "bold"), ("answer", "fg:ansicyan"),
         ("pointer", "fg:ansicyan bold"), ("highlighted", "fg:ansicyan bold"), ("instruction", "fg:ansibrightblack")]
"""How questions on a terminal look: ANSI colour names only, so they follow the terminal's theme."""


def closed_input(question: str) -> OnboardError:
    """The error for stdin ending before ``question`` was answered."""
    return OnboardError(f"no answer to {question!r} (stdin closed)")


TYPE_OWN = "Type my own answer"
"""The last choice of a typed list on the terminal; picking it asks for the answer."""


class TtyPrompter:
    """Asks on the terminal; a secret is read with ``getpass``, so it is never echoed.

    ``preset`` answers questions by their text without asking (from command-line flags);
    with ``interactive`` False, every other question takes its default. When stdin and stdout
    are both terminals (or ``terminal`` gives one), a list is picked with the arrow keys;
    otherwise it is numbered, and a line picks from it. A typed list ends with ``TYPE_OWN``,
    which asks for the answer; an empty one is ``default``.
    """

    def __init__(self, preset: Mapping[str, str] | None = None, interactive: bool = True, *,
                 terminal: "tuple[Input, Output] | None" = None) -> None:
        self.preset = {k: v for k, v in (preset or {}).items() if v}
        self.interactive = interactive
        self.terminal = terminal
        # Read now: the init flow runs its questions in an environment without these.
        self.dumb = os.environ.get("TERM") == "dumb"
        self.color = not os.environ.get("NO_COLOR") and not self.dumb

    def _styled(self) -> bool:
        """Whether to colour what is printed: colour is on and it goes to a terminal."""
        return self.color and (self.terminal is not None or sys.stdout.isatty())

    def _terminal(self) -> "tuple[Input | None, Output | None] | None":
        """The input and output to draw questions on (None for the process's own), or None to ask line by line."""
        if not self.interactive:
            return None
        if self.terminal is not None:
            return self.terminal
        # A dumb terminal can't move the cursor to redraw a list.
        if sys.stdin.isatty() and sys.stdout.isatty() and not self.dumb:
            return None, None
        return None

    def _questionary_kwargs(self, terminal: "tuple[Input | None, Output | None]") -> dict[str, Any]:
        """What every questionary question gets: the style, the terminal, and no colour if the owner turned it off."""
        import questionary  # not loaded until a question is drawn
        from prompt_toolkit.output import ColorDepth

        extra = {} if self.color else {"color_depth": ColorDepth.DEPTH_1_BIT}
        return {"style": questionary.Style(STYLE), "qmark": "?", "input": terminal[0], "output": terminal[1], **extra}

    def ask(self, question: str, default: str = "") -> str:
        if question in self.preset:
            return self.preset[question]
        if not self.interactive:
            return default
        try:
            if (terminal := self._terminal()) is not None:
                import questionary

                answer = questionary.text(question, default=default, **self._questionary_kwargs(terminal)).unsafe_ask()
                return answer.strip() or default
            shown = f"{question} [{default}]: " if default else f"{question}: "
            return input(shown).strip() or default
        except EOFError:
            raise closed_input(question) from None

    def choose(self, question: str, options: Sequence[str], default: str = "", typed: bool = False) -> str:
        if question in self.preset:
            return self.preset[question]
        if not self.interactive:
            return default
        if not typed:
            return self._pick(question, options, default)
        # A list on the terminal can't take text, so a last choice asks for it.
        own = default if default not in options else ""
        picked = self._pick(question, [*options, TYPE_OWN], TYPE_OWN if own else default)
        if picked != TYPE_OWN:
            return picked
        # An empty typed answer is the default, as on the JSON path, so a deployment is never saved empty.
        return self.ask(question, own) or default

    def _pick(self, question: str, options: Sequence[str], default: str) -> str:
        """One of ``options`` picked from a list, ``default`` for an empty answer."""
        if (terminal := self._terminal()) is not None:
            import questionary

            try:
                # select refuses a default that isn't one of its choices.
                return questionary.select(question, choices=list(options),
                                          default=default if default in options else None,
                                          instruction="(↑/↓, Enter)", **self._questionary_kwargs(terminal)).unsafe_ask()
            except EOFError:
                raise closed_input(question) from None
        for number, option in enumerate(options, 1):
            self.say(f"  {number}. {option}")
        shown = f"{question} [{default}]: " if default else f"{question}: "
        for _ in range(TRIES):
            try:
                line = input(shown).strip()
            except EOFError:
                raise closed_input(question) from None
            # An option is taken before a number, so an option that is a number picks itself.
            if line in options:
                return line
            if line.isdecimal() and 1 <= int(line) <= len(options):
                return options[int(line) - 1]
            if not line:
                return default
            self.say(f"That doesn't work: choose 1 to {len(options)}")
        raise OnboardError(f"no usable answer to {question!r}")

    def secret(self, question: str) -> str:
        if not self.interactive or not sys.stdin.isatty():
            # getpass falls back to reading stdin with echo when there is no terminal.
            raise NoTerminal(f"there is no terminal to read {question!r} without echo")
        # The same mark as a question drawn by questionary.
        mark = "\x1b[1;36m?\x1b[0m " if self._styled() else ""
        return getpass.getpass(f"{mark}{question}: ").strip()

    def say(self, text: str) -> None:
        print(text, flush=True)

    def step(self, number: int, total: int, title: str, why: str) -> None:
        header, line = step_lines(number, total, title, why)
        if self._styled():
            # Raw codes, not questionary.print: prompt_toolkit keeps the first stdout it prints to.
            header, line = f"\x1b[1;36m{header}\x1b[0m", f"\x1b[90m{line}\x1b[0m"
        print(f"\n{header}\n{line}", flush=True)


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
        raise OnboardError(f"yian won't take this provider: {_llm_errors(exc)}") from None
    if "api_key" in llm and not llm.get("provider"):
        # Composer refuses a key without a provider at run time; say so now.
        raise OnboardError("llm_config.api_key needs llm_config.provider, so the key goes only to that provider")
    name = llm.get("provider")
    # Without a key, runs use the login `yian auth <name>` saved, which names its model.
    if name and not llm.get("model") and "api_key" in llm and name not in models.DEFAULT_MODELS:
        # Composer finds this out only when a run starts; say so before the provider is saved.
        raise OnboardError(f"llm_config.model is missing, and {name} has no default model")
    return provider


def with_default_model(provider: Provider) -> Provider:
    """``provider`` naming its default model when it has a key and names none.

    Yian has no default model. Without a key, runs use ``yian auth``'s login, which names one.

    Raises:
        OnboardError: ``provider`` has a key for an endpoint of the owner's own and names no model, since that
            endpoint has no default.
    """
    llm = provider.llm_config or {}
    if llm.get("model") or "api_key" not in llm:
        return provider
    if "base_url" in llm:
        raise OnboardError("llm_config.model is missing, and an endpoint of your own has no default model")
    default = models.DEFAULT_MODELS.get(llm.get("provider"))
    return provider if default is None else provider.model_copy(update={"llm_config": {**llm, "model": default}})


_azure_base_url = azure_base_url


def azure_deployments(base_url: str, key: str) -> list[str]:
    """The deployments at the Azure OpenAI resource whose v1 endpoint is ``base_url`` that are ready and not
    embedding models, in Azure's order.

    Raises:
        OnboardError: they couldn't be listed; the message never contains the key.
    """
    try:
        return models.azure_deployments(base_url, key, timeout=15)
    except models.ModelListError as exc:
        raise OnboardError(str(exc)) from None


def provider_models(name: str, key: str) -> list[str]:
    """The models provider ``name`` lists for ``key`` (an empty key sends none), sorted; none when it has no
    listing.

    Raises:
        OnboardError: they couldn't be listed; the message never contains the key.
    """
    try:
        return models.provider_models(name, key or None, timeout=15) or []
    except models.ModelListError as exc:
        raise OnboardError(str(exc)) from None


def _ask_deployment(prompter: Prompter, base_url: str, key: str, last: str) -> str:
    """The deployment to use at the resource whose v1 endpoint is ``base_url``, picked from its list when it can be
    listed, ``last`` for an empty answer."""
    try:
        deployments = azure_deployments(base_url, key)
    except OnboardError as exc:
        prompter.say(f"Couldn't list the deployments ({exc}); type the name instead.")
        deployments = []
    if deployments:
        return prompter.choose("Deployment", deployments, last or deployments[0], typed=True).strip()
    return ask_until(prompter, "Deployment name", last,
                     lambda m: None if m.strip() else "type the deployment's name").strip()


def _azure_problem(answer: str) -> str | None:
    """Why ``answer`` doesn't name an Azure OpenAI endpoint, or None when it does."""
    try:
        LLMConfig(provider="openai", base_url=_azure_base_url(answer), api_key="-")
    except ValidationError:
        return "give the resource name, or its endpoint like https://<resource>.openai.azure.com"
    return None


def _ask_key(prompter: Prompter, name: str, *, required: bool, last: str = "") -> str:
    """The key for provider ``name``, read without echo; empty only when not ``required``, and ``last`` for an empty
    answer when there is one."""
    if last:
        question = f"{name} API key (empty keeps the one you just typed; not shown)"
    elif required:
        question = f"{name} API key (not shown)"
    else:
        question = f"{name} API key (empty to use `yian auth {name}`; not shown)"
    for _ in range(TRIES):
        try:
            key = prompter.secret(question) or last
        except NoTerminal:
            raise OnboardError("there is no terminal to read the key without echo;"
                               " pass the provider with --provider-stdin instead") from None
        if key or not required:
            return key
        prompter.say(f"That doesn't work: {name} needs a key")
    raise OnboardError(f"no usable answer to {question!r}")


def _ask_model(prompter: Prompter, name: str, last: str = "", key: str = "") -> str:
    """The model for provider ``name``, picked from those it lists for ``key`` when it can be listed, ``last`` for an
    empty answer; empty, without a key, for the model of yian's own login."""
    if not key and name not in models.KEYLESS:
        # The runs use composer's own login, which saved its model and which the listing can't use.
        login = f"the model `yian auth {name}` saved"
        picked = prompter.choose("Model", [login], last or login, typed=True)
        return "" if picked == login else picked
    listed = []
    if prompter.interactive:
        try:
            listed = provider_models(name, key)
        except OnboardError as exc:
            prompter.say(f"Couldn't list the models ({exc}).")
    if key and (default := models.DEFAULT_MODELS.get(name)):
        first = f"{default} (the default)"
        # Typing a name picks another model; the one typed last time is the answer for nothing.
        picked = prompter.choose("Model", [first, *(m for m in listed if m != default)], last or first, typed=True)
        return default if picked == first else picked
    if listed:
        return prompter.choose("Model", listed, last or listed[0], typed=True)
    return ask_until(prompter, f"Model name ({name} has no default model)", last,
                     lambda m: None if m.strip() else "type the model's name")


def _ask_provider(prompter: Prompter, last: dict[str, str]) -> dict:
    """The provider the owner gives, each question defaulting to its answer in ``last``, which gets these answers."""
    choices = ", ".join(SUPPORTED_LLM_PROVIDERS)
    name = ask_until(prompter, "Model provider", last.get("provider", "anthropic"),
                     lambda n: None if n in SUPPORTED_LLM_PROVIDERS else f"choose one of: {choices}",
                     options=SUPPORTED_LLM_PROVIDERS)
    if name != last.get("provider"):
        # A key goes only to the provider it was typed for.
        last.clear()
        last["provider"] = name
    if name == "azure":
        # Composer's azure client reads its endpoint from variables the office doesn't have; a resource's v1
        # endpoint takes the openai client with the key and the deployment as the model.
        last["endpoint"] = ask_until(prompter, "Azure OpenAI endpoint or resource name", last.get("endpoint", ""),
                                     _azure_problem)
        last["key"] = _ask_key(prompter, name, required=True, last=last.get("key", ""))
        base_url = _azure_base_url(last["endpoint"])
        last["model"] = _ask_deployment(prompter, base_url, last["key"], last.get("model", ""))
        return {"llm_config": {"provider": "openai", "base_url": base_url, "api_key": last["key"],
                               "model": last["model"]}}
    llm = {"provider": name}
    last["key"] = _ask_key(prompter, name, required=False, last=last.get("key", ""))
    if last["key"]:
        llm["api_key"] = last["key"]
    else:
        prompter.say(f"No key saved; runs will use yian's own login (`yian auth {name}`).")
    last["model"] = _ask_model(prompter, name, last.get("model", ""), last["key"]).strip()
    if last["model"]:
        llm["model"] = last["model"]
    return {"llm_config": llm}


TRY_AGAIN = "Try again"
SET_UP_AGAIN = "Set up the model again"
"""What to do when the model doesn't answer."""

ModelCheck = Callable[[Provider], str | None]
"""Why a provider's model doesn't answer, or None when it does."""


def model_failed(prompter: Prompter, problem: str) -> bool:
    """Tell the owner why the model failed and ask what to do; return whether they want to set it up again."""
    prompter.say(problem[:1].upper() + problem[1:])
    return prompter.choose("What now?", [TRY_AGAIN, SET_UP_AGAIN], TRY_AGAIN) == SET_UP_AGAIN


def _answers(prompter: Prompter, provider: Provider, check_model: ModelCheck) -> bool:
    """Whether ``provider``'s model answers, checking again for as long as the owner chooses to try again."""
    while True:
        prompter.say("Checking that the model answers...")
        if (problem := check_model(provider)) is None:
            return True
        if not prompter.interactive:
            raise OnboardError(f"the model didn't answer: {problem}")
        if model_failed(prompter, f"the model didn't answer: {problem}"):
            return False


def _working_provider(prompter: Prompter, check_model: ModelCheck | None, last: dict[str, str]) -> Provider:
    """Ask for a provider until composer takes it and its model answers ``check_model``, starting from the answers
    in ``last``; only Ctrl-C or the input ending stops it."""
    while True:
        data = _ask_provider(prompter, last)
        try:
            provider = check_provider(data)
        except OnboardError as exc:
            if not prompter.interactive:
                raise
            prompter.say(f"That doesn't work: {exc}")
            continue
        if check_model is None or _answers(prompter, provider, check_model):
            return provider


def _save_provider(path: Path, provider: Provider) -> None:
    """Write ``provider`` to ``path``, readable only by the owner, and check it loads back."""
    try:
        write_private(path, (json.dumps(provider.model_dump(exclude_defaults=True), indent=2) + "\n").encode())
    except OSError as exc:
        raise OnboardError(f"can't write {path}: {exc.strerror or exc}") from None
    try:
        load_provider(path)
    except ProviderError as exc:
        raise OnboardError(str(exc)) from None


def ask_provider(path: Path, prompter: Prompter, check_model: ModelCheck | None = None, *,
                 last: dict[str, str] | None = None) -> None:
    """Ask the owner for a provider until its model answers ``check_model``, then save it at ``path``. Each question
    defaults to its answer in ``last``, which gets the new answers, so asking again starts where the owner left off.

    Raises:
        OnboardError: there's no one to ask, or the file can't be written; the message never contains the key.
    """
    _save_provider(path, _working_provider(prompter, check_model, {} if last is None else last))


def ensure_provider(path: Path, prompter: Prompter, stdin: TextIO | None = None, *,
                    check_model: ModelCheck | None = None, last: dict[str, str] | None = None) -> bool:
    """Make sure ``path`` holds a usable provider; return whether it was written.

    A provider on ``stdin`` (JSON) is checked and replaces the file, so a key can be rotated. Without one, an
    existing file is checked and kept (written again if it lacks the default model a key needs; on a terminal, one
    composer can't use is asked for again), and a missing one
    is asked of the owner, the key read without echo, until its model answers ``check_model``. Nothing is written
    before the model answers. The key never goes through argv or the environment. ``last`` is as for
    :func:`ask_provider`.

    Raises:
        OnboardError: the provider isn't usable; the message never contains the key. An
            existing file is left as it was.
    """
    if stdin is None:
        if os.path.lexists(path):
            again = "fix it or remove it and run `opencorp onboard` again"
            try:
                saved = load_provider(path).model_dump(exclude_defaults=True)
                checked = with_default_model(check_provider(saved))
                if checked.model_dump(exclude_defaults=True) == saved:
                    return False
                # A file from when yian had a default model gets the one it now needs.
                _save_provider(path, checked)
                return True
            except ProviderError as exc:  # its message names the file
                raise OnboardError(f"{exc}; {again}") from None
            except OnboardError as exc:
                if not prompter.interactive:
                    raise OnboardError(f"{path}: {exc}; {again}") from None
                prompter.say(f"{path}: {exc}; set up the model again.")
        ask_provider(path, prompter, check_model, last=last)
        return True
    try:
        data = json.loads(stdin.read())
    except ValueError:
        raise OnboardError("the provider on stdin is not valid JSON") from None
    provider = with_default_model(check_provider(data))
    if check_model is not None and (problem := check_model(provider)) is not None:
        raise OnboardError(f"the model didn't answer: {problem}")
    _save_provider(path, provider)
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


TRIES = 5
"""How many answers a question takes before giving up: a preset or a default comes back the same each time."""


def ask_until(prompter: Prompter, question: str, default: str, problem: Callable[[str], str | None],
              options: Sequence[str] = ()) -> str:
    """Ask ``question`` until ``problem`` finds nothing wrong with the answer, at most ``TRIES`` times; with
    ``options``, the owner picks the answer from them.

    Raises:
        OnboardError: no answer worked.
    """
    for _ in range(TRIES):
        answer = prompter.choose(question, options, default) if options else prompter.ask(question, default)
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


GIT_ACCESS = ("if git needs a login or a new host key, set that up in a terminal first"
              " (`gh auth login`, or `ssh -T git@HOST` once)")
"""What to do when a clone or push fails: under ``opencorp``'s setup screen git has no terminal to ask on."""


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
        raise OnboardError(f"can't clone {redact(url)}: {redact(done.stderr.strip())}; {GIT_ACCESS},"
                           " then run `opencorp onboard` again")
    if is_new(dest):
        remove_path(dest)
        raise OnboardError(f"{redact(url)} isn't a company repo: it has no company.yaml at its top")


def _login_handle() -> str:
    try:
        return login_defaults()[1]
    except OnboardError:
        return ""


def _join(root: Path, worktrees: Path, home: Path, prompter: Prompter) -> Identity | None:
    """This device's identity in the company at ``root``: kept if the company lists it, else made and committed.

    A new identity is for the human you pick: the default is the human whose handle is this
    login's, otherwise the only human. A human with a password must give it; without a
    terminal to ask on, the device is left out (None) for ``opencorp login`` to add. A device name
    the human already lists gets a ``-2`` (``-3``, ...) suffix.

    Raises:
        OnboardError: there's no human, no answer names one, the password never matched, or the
            device can't be added.
    """
    people = load_repo(root).people
    known = read_identity(identity_path(home))
    if known is not None and known.handle in people and token_sha256(known.token) in {
            d.token_sha256 for d in people[known.handle].devices}:
        return known
    humans = sorted(h for h, p in people.items() if p.kind == "human")
    if not humans:
        raise OnboardError("the company has no humans for this device to act as")
    login = _login_handle()
    default = login if login in humans else humans[0] if len(humans) == 1 else ""
    # With no one to ask, nothing is listed, so the problem names the humans and the flag.
    pick = f"say which one you are ({', '.join('@' + h for h in humans)}), or pass --handle"
    handle = ask_until(prompter, WHO, default, lambda h: None if h in humans else
                       f"@{h} isn't one of them" if h else pick, options=humans)
    password_hash = people[handle].password_hash
    if password_hash is not None:
        try:
            _ask_password(prompter, handle, password_hash)
        except NoTerminal:
            prompter.say(f"There's no terminal to ask for @{handle}'s password on, so this device isn't added.")
            return None
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
    if password_hash is None:
        prompter.say(f"@{handle} has no password yet; set one with `opencorp password` so a new device has to give it")
    return me


def _ask_password(prompter: Prompter, handle: str, password_hash: str) -> None:
    """Ask for ``handle``'s password until it matches ``password_hash``, at most ``TRIES`` times.

    Raises:
        NoTerminal: there's no terminal to ask on.
        OnboardError: no answer matched.
    """
    for _ in range(TRIES):
        if check_password(prompter.secret(f"@{handle}'s password (not shown)"), password_hash):
            return
        prompter.say("That doesn't work: wrong password")
    raise OnboardError(f"wrong password for @{handle}")


STEPS = 4
"""Onboarding's steps: the company, this device, the model, and the office."""


def onboard(home: Path, prompter: Prompter, *, mode: str = "auto", stdin: TextIO | None = None,
            host: Host | None = None, repo: Path = REPO, environ: Mapping[str, str] = os.environ,
            source: str | None = None, steps: bool = True) -> None:
    """Set up this machine's office for the company at ``home``; running it again only fills in what is missing.

    In order: the home and office dirs (0700); the company repo, cloned from ``source`` (or a
    URL asked for) when there's none here, and topped up with any template files it lacks
    (lint errors stop here; left alone while the office runs); this device, which for a
    cloned company is listed for the human you pick (after their password, if they have
    one) and committed in the clone before the office starts, unless the company already
    lists this device's identity; ``office/provider.json``; and the daemon under ``mode``. With ``steps``,
    each step gets a numbered header (``opencorp init`` turns them off, since onboarding is one of
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
                               " stop it and run `opencorp onboard` again")
        if paths.company.is_dir() and any(paths.company.iterdir()):
            raise OnboardError(f"{paths.company} holds a company that was never finished (no first commit);"
                               " run `opencorp init` to finish it, or remove it to join another")
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
            raise OnboardError("the company repo has errors; fix them and run `opencorp onboard` again:\n"
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
        prompter.say("This device has no identity yet; run `opencorp login` to use opencorp from it.")

    step(3, "Model", "Your agents think with this model; its key stays in this office, readable only by you.")
    from opencorp.install.interview import model_problem  # interview imports this module

    wrote = ensure_provider(paths.office / "provider.json", prompter, stdin, check_model=model_problem)
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
    prompter.say("Done. Run `opencorp` in a project folder to talk to your team.")

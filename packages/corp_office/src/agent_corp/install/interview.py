"""`ac init`'s flow (an interview that asks on the terminal, the owner's confirmation, a password and a remote),
and the draft without a terminal."""

import json
import os
import warnings
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from agent_composer import load_flow, run_flow

from agent_corp.chat.provider import Provider, load_provider
from agent_corp.company.draft import Draft, Teammate, draft_problems, field_problems
from agent_corp.company_template import Owner
from agent_corp.install.onboard import OnboardError, Prompter, login_defaults, redact, slug
from agent_corp.tools.company.draft import check_company
from agent_corp.worker.spawn import worker_env

FLOW = Path(__file__).parent / "flows" / "init.yaml"
"""The init flow."""

CHECK = Path(__file__).parent / "flows" / "check_model.yaml"
"""The flow that checks the model answers."""

CONFIRM = "Create this company?"
CREATE = "Yes, create it"
CHANGE = "No, change something"
WHAT_TO_CHANGE = "What should change? (empty to talk it over)"
"""What the owner is asked after the summary, the two answers, and what is asked after the second."""

TYPE_OWN = "Type my own answer"
"""The last choice for a question the model gives options for."""

FLAGS = {"company": "--company", "owner.name": "--name", "owner.handle": "--handle",
         "teammate.name": "--agent", "teammate.handle": "--agent-handle"}
"""The ``ac init`` flag that sets each draft field a problem can be about."""


@dataclass(frozen=True)
class Known:
    """What the owner gave as command-line flags; empty for what they didn't give."""

    company: str = ""
    name: str = ""
    """The owner's name."""
    handle: str = ""
    """The owner's handle."""
    title: str = ""
    """The owner's title."""
    agent: str = ""
    """The first teammate's name."""
    agent_handle: str = ""
    """The first teammate's handle."""
    remote: str = ""
    """The git remote URL."""

    def facts(self) -> dict[str, dict[str, str]]:
        """What the interview is told: ``given``, the fields that are set, and ``suggested`` defaults for the owner.

        Raises:
            OnboardError: the user id has no account.
        """
        name, handle = login_defaults()
        # A remote URL can hold credentials, so it never reaches the model.
        given = {k: v for k, v in asdict(self).items() if v and k != "remote"}
        return {"given": given, "suggested": {"name": name, "handle": handle, "title": "CEO"}}


def fallback_draft(known: Known) -> Draft:
    """The draft without an interview: ``known``, with defaults for the rest and one teammate.

    Raises:
        OnboardError: the draft has problems, and the message names the flag to pass for each;
            or the user id has no account.
    """
    name, handle = login_defaults()
    agent = known.agent or "Minh"
    draft = Draft(known.company or "My company",
                  Owner(handle=known.handle or handle, name=known.name or name, title=known.title or "CEO"),
                  (Teammate(agent, known.agent_handle or slug(agent) or "agent", "Engineer"),))
    if problems := field_problems(draft):
        raise OnboardError("can't set up the company without a terminal: "
                           + "; ".join(f"{why}; pass {FLAGS[field]}" if field in FLAGS else why
                                       for field, why in problems))
    return draft


# C1 controls (0x80-0x9f) go too: some terminals read 0x9b as the start of an escape sequence.
_CONTROL = dict.fromkeys([*range(0x20), *range(0x7F, 0xA0)]) | dict.fromkeys(map(ord, "\n\r\t"), " ")


def clean(text: str) -> str:
    """``text`` safe to print: line breaks and tabs become spaces and other control characters are dropped, so
    model text can't move the cursor or send escapes."""
    return text.translate(_CONTROL)


def _who(name: str, handle: str, title: str) -> str:
    return clean(f"{name} (@{handle})" + (f", {title}" if title else ""))


def summary(draft: Draft) -> list[str]:
    """``draft`` as shown to the owner to confirm: the company, the owner, and a line for each teammate."""
    owner = draft.owner
    lines = [f"Company: {clean(draft.company)}", f"You: {_who(owner.name, owner.handle, owner.title)}"]
    if not draft.team:
        return [*lines, "Teammates: none yet"]
    lines.append("Teammates:")
    for t in draft.team:
        about = clean(t.about).strip()
        lines.append(f"  {_who(t.name, t.handle, t.title)}" + (f": {about}" if about else ""))
    return lines


@contextmanager
def _office_env(extra: dict[str, str]) -> Iterator[None]:
    """``os.environ`` as an office worker's plus ``extra`` inside the block, and exactly as it was after."""
    saved, env = dict(os.environ), worker_env() | extra
    try:
        os.environ.clear()
        os.environ.update(env)
        yield
    finally:
        os.environ.clear()
        os.environ.update(saved)


@dataclass
class Asking:
    """The owner's terminal for one init flow run, and the ``OnboardError`` that stopped it, if one did."""

    prompter: Prompter
    stopped: OnboardError | None = None


# Code nodes are named by module:function, so they reach the terminal through this rather than a closure.
_ASKING: ContextVar[Asking] = ContextVar("asking")


@contextmanager
def asking(state: Asking) -> Iterator[None]:
    """Make ``state`` the terminal that ``owner_prompter`` gives inside the block."""
    token = _ASKING.set(state)
    try:
        yield
    finally:
        _ASKING.reset(token)


@contextmanager
def owner_prompter() -> Iterator[Prompter]:
    """The running init flow's prompter, for its tools and code nodes.

    An ``OnboardError`` raised inside is kept, so the run's caller raises it rather than the run's failure.
    """
    state = _ASKING.get()
    try:
        yield state.prompter
    except OnboardError as exc:
        state.stopped = exc
        raise


def confirm(inputs: dict) -> dict:
    """The init flow's ``confirm`` node: check the draft in ``inputs["answers"]`` and, if it has no problems, show it
    and ask the owner to create the company.

    Returns the round's ``draft`` (as JSON), its ``changes`` (the problems, or what the owner wants changed) and
    whether the owner ``accepted``.
    """
    text = json.dumps(inputs["answers"])
    draft = Draft.from_output(inputs["answers"])
    if problems := draft_problems(draft):
        return {"draft": text, "changes": "\n".join(problems), "accepted": False}
    with owner_prompter() as prompter:
        for line in summary(draft):
            prompter.say(line)
        if prompter.choose(CONFIRM, [CREATE, CHANGE], CREATE) != CHANGE:
            return {"draft": text, "changes": "", "accepted": True}
        reply = prompter.ask(WHAT_TO_CHANGE).strip()
    changes = f"The owner wants changes: {reply}" if reply else "The owner wants changes; ask what to change"
    return {"draft": text, "changes": changes, "accepted": False}


def ask_user(**request) -> str:
    """Ask the owner ``request["question"]``; with ``request["options"]``, they pick one or type their own answer.

    A picked option goes back as the model wrote it, not as it was shown.
    """
    options = request.get("options") or []
    question = clean(request["question"])
    with owner_prompter() as prompter:
        if not options:
            return prompter.ask(question)
        shown = [clean(o) for o in options]
        picked = prompter.choose(question, [*shown, TYPE_OWN])
        if picked == TYPE_OWN:
            return prompter.ask(question)
    # Anything else, such as an empty line with no option picked, goes back as it is.
    return options[shown.index(picked)] if picked in shown else picked


class ModelError(OnboardError):
    """The model couldn't run the init flow."""


def _run(flow, inputs: dict, provider: Provider, tools: dict) -> tuple[Any, str | None]:
    """Run ``flow`` with ``provider``'s model as an office run would: its result, and why it failed (None if it
    didn't), without the key or URL credentials."""
    result = message = None
    # The run gets the environment office runs get, so it authenticates the way they will: a shell variable the
    # office never sees can't make it work.
    try:
        with _office_env(provider.env), warnings.catch_warnings():
            # An Azure deployment or a gateway's model is never in composer's list; the owner chose it on purpose.
            warnings.filterwarnings("ignore", r"Model .* is not in the known model list", RuntimeWarning)
            # No workers: the handler and the code nodes, and so the terminal, stay on the main thread.
            result = run_flow(flow, inputs, llm_config=provider.llm_config, tools=tools, num_workers=0)
        if result.status == "failed":
            message = result.failure.message
    except Exception as exc:
        message = str(exc)
    if message is not None:
        if key := (provider.llm_config or {}).get("api_key"):
            message = message.replace(str(key), "***")
        message = redact(message).rstrip(".")
    return result, message


def model_problem(provider: Provider) -> str | None:
    """Why ``provider``'s model doesn't answer a one-word request made as an office run makes it, or None when it
    answers."""
    return _run(load_flow(CHECK.read_text(), source_label=str(CHECK)), {}, provider, {})[1]


def run_init_flow(provider: Provider, prompter: Prompter, known: Known) -> dict:
    """Run the init flow with ``provider``'s model, asking the owner with ``prompter``; return its output.

    Raises:
        ModelError: the run failed.
        OnboardError: the owner's input ended or no password worked (the error raised), the interview didn't settle
            on a company, or the user id has no account.
    """
    flow = load_flow(FLOW.read_text(), source_label=str(FLOW))
    inputs = {"known": json.dumps(known.facts()), "remote": known.remote}
    state = Asking(prompter)
    with asking(state):
        result, message = _run(flow, inputs, provider, {"ask_user": ask_user, "check_company": check_company})
    if state.stopped:
        raise state.stopped
    if result is not None and result.status == "failed" and result.failure.cause_type == "LoopMaxExceeded":
        raise OnboardError("the interview didn't settle on a company; run `ac init` again")
    if message is not None:
        raise ModelError(f"the model couldn't run the interview: {message}")
    return result.output


def init_flow(provider_path: Path, prompter: Prompter, known: Known) -> tuple[Draft, str]:
    """The new company with its CEO's password hash, and the git remote URL (empty for none), from the init flow run
    with the model in ``provider_path``, starting from ``known``.

    Raises:
        OnboardError: ``run_init_flow`` raised.
        ProviderError: the provider file can't be used.
    """
    output = run_init_flow(load_provider(provider_path), prompter, known)
    return Draft.from_output(output), output["remote"]

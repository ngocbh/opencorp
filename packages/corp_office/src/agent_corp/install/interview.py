"""The owner's interview for a new company: a flow that asks on the terminal, and the checks on what it returns."""

import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path

from agent_composer import load_flow, run_flow
from pydantic import ValidationError

from agent_corp.chat.provider import Provider
from agent_corp.company_template import Owner, template_files
from agent_corp.install.onboard import OnboardError, Prompter, handle_problem, login_defaults, redact, slug
from agent_corp.protocol.models import HireRequest
from agent_corp.worker.spawn import worker_env

FLOW = Path(__file__).parent / "flows" / "init.yaml"
"""The interview flow."""


@dataclass(frozen=True)
class Teammate:
    """A first teammate: an agent reporting to the CEO, with a sentence that seeds their profile."""

    name: str
    handle: str
    title: str
    about: str = ""


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


@dataclass(frozen=True)
class Answers:
    """A new company: its name, its CEO and its first teammates."""

    company: str
    owner: Owner
    team: tuple[Teammate, ...]

    @classmethod
    def from_output(cls, output: dict) -> "Answers":
        """The answers in the interview flow's output, with its ``company``, ``owner`` and ``teammates``."""
        owner = output["owner"]
        return cls(output["company"], Owner(handle=owner["handle"], name=owner["name"], title=owner["title"]),
                   tuple(Teammate(t["name"], t["handle"], t["title"], t["about"]) for t in output["teammates"]))


def _problems(answers: Answers) -> list[tuple[str | None, str]]:
    """Each problem with ``answers``, after the flag that sets what it's about, or None if no flag does."""
    owner = answers.owner
    found: list[tuple[str | None, str]] = []
    if not answers.company.strip():
        found.append(("--company", "the company needs a name"))
    if not owner.name.strip():
        found.append(("--name", "the owner needs a name"))
    if why := handle_problem(owner.handle):
        found.append(("--handle", f"@{owner.handle} can't be a handle: {why}"))
    if not found:
        try:
            template_files(answers.company, owner)  # validates without writing
        except ValueError as exc:
            found.append((None, f"that company doesn't work: {exc}"))
    taken = {owner.handle}
    for t in answers.team:
        mine: list[tuple[str | None, str]] = []
        if not t.name.strip():
            mine.append(("--agent", f"the teammate @{t.handle} needs a name"))
        if not t.title.strip():
            mine.append((None, f"the teammate @{t.handle} needs a title"))
        if why := handle_problem(t.handle):
            mine.append(("--agent-handle", f"@{t.handle} can't be a handle: {why}"))
        elif t.handle in taken:
            mine.append(("--agent-handle", f"@{t.handle} is taken"))
        taken.add(t.handle)
        if not mine and not handle_problem(owner.handle):
            try:
                HireRequest(name=t.name, handle=t.handle, title=t.title, manager=owner.handle)
            except ValidationError as exc:
                mine.append((None, f"@{t.handle} can't be hired: {exc.errors(include_url=False)[0]['msg']}"))
        found += mine
    return found


def answer_problems(answers: Answers) -> list[str]:
    """What's wrong with ``answers``, one problem each; empty when the company can be made from them."""
    return [why for _, why in _problems(answers)]


def fallback_answers(known: Known) -> Answers:
    """The answers without an interview: ``known``, with defaults for the rest and one teammate.

    Raises:
        OnboardError: the answers have problems, and the message names the flag to pass for each;
            or the user id has no account.
    """
    name, handle = login_defaults()
    agent = known.agent or "Minh"
    answers = Answers(known.company or "My company",
                      Owner(handle=known.handle or handle, name=known.name or name, title=known.title or "CEO"),
                      (Teammate(agent, known.agent_handle or slug(agent) or "agent", "Engineer"),))
    if problems := _problems(answers):
        raise OnboardError("can't set up the company without a terminal: "
                           + "; ".join(f"{why}; pass {flag}" if flag else why for flag, why in problems))
    return answers


# C1 controls (0x80-0x9f) go too: some terminals read 0x9b as the start of an escape sequence.
_CONTROL = dict.fromkeys([*range(0x20), *range(0x7F, 0xA0)]) | dict.fromkeys(map(ord, "\n\r\t"), " ")


def clean(text: str) -> str:
    """``text`` safe to print: line breaks and tabs become spaces and other control characters are dropped, so
    model text can't move the cursor or send escapes."""
    return text.translate(_CONTROL)


def _who(name: str, handle: str, title: str) -> str:
    return clean(f"{name} (@{handle})" + (f", {title}" if title else ""))


def summary(answers: Answers) -> list[str]:
    """``answers`` as shown to the owner to confirm: the company, the owner, and a line for each teammate."""
    owner = answers.owner
    lines = [f"Company: {clean(answers.company)}", f"You: {_who(owner.name, owner.handle, owner.title)}"]
    if not answers.team:
        return [*lines, "Teammates: none yet"]
    lines.append("Teammates:")
    for t in answers.team:
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


def run_interview(provider: Provider, prompter: Prompter, known: Known, *, draft: str, changes: str,
                  provider_path: Path) -> dict:
    """Run the interview flow once with ``provider``'s model, asking its questions with ``prompter``; return its output.

    ``draft`` is the JSON of the last output and ``changes`` what to change in it; both are empty on a first run.

    Raises:
        OnboardError: the owner's input ended (the prompter's own error), the run failed, or the user id has no
            account.
    """
    flow = load_flow(FLOW.read_text(), source_label=str(FLOW))
    inputs = {"known": json.dumps(known.facts()), "draft": draft, "changes": changes}
    stopped: OnboardError | None = None

    def ask_user(**request):
        nonlocal stopped
        options = request.get("options") or []
        for number, option in enumerate(options, 1):
            prompter.say(f"  {number}. {clean(option)}")
        try:
            answer = prompter.ask(clean(request["question"]))
        except OnboardError as exc:
            stopped = exc
            raise
        if answer.strip().isdecimal() and 1 <= int(answer) <= len(options):
            return options[int(answer) - 1]
        return answer

    # The run gets the environment office runs get, so the interview authenticates the way they will: a shell
    # variable the office never sees can't make it work.
    try:
        with _office_env(provider.env):
            # No workers: the handler, and so the terminal, stays on the main thread.
            result = run_flow(flow, inputs, llm_config=provider.llm_config, tools={"ask_user": ask_user},
                              num_workers=0)
        message = result.failure.message if result.status == "failed" else None
    except Exception as exc:
        message = str(exc)
    if stopped:
        raise stopped
    if message is not None:
        if key := (provider.llm_config or {}).get("api_key"):
            message = message.replace(str(key), "***")
        raise OnboardError(f"the model couldn't run the interview: {redact(message)}; check or remove "
                           f"{provider_path} and run `ac init` again")
    return result.output

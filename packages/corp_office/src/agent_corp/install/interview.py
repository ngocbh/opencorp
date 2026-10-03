"""The owner's interview for a new company: a flow that asks on the terminal, and defaults without one."""

import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path

from agent_composer import load_flow, run_flow

from agent_corp.chat.provider import Provider, load_provider
from agent_corp.company.draft import Draft, Teammate, draft_problems, field_problems
from agent_corp.company_template import Owner
from agent_corp.install.onboard import TRIES, OnboardError, Prompter, login_defaults, redact, slug
from agent_corp.worker.spawn import worker_env

FLOW = Path(__file__).parent / "flows" / "init.yaml"
"""The interview flow."""

CONFIRM = "Create this company? (Y/n, or say what to change)"
"""What the owner is asked after the summary."""

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


def interview(provider_path: Path, prompter: Prompter, known: Known) -> Draft:
    """The new company: from an interview with the model in ``provider_path``, checked and confirmed by the owner;
    or, with no one at a terminal, ``fallback_draft(known)``.

    Results with problems run the interview again to fix them, at most ``TRIES`` times in all; changes the owner asks
    for run it again without counting.

    Raises:
        OnboardError: the interview didn't settle on a company, or ``run_interview`` or ``fallback_draft`` raised.
        ProviderError: the provider file can't be used.
    """
    if not prompter.interactive:
        return fallback_draft(known)
    provider = load_provider(provider_path)
    draft = changes = ""
    failed = 0
    while True:
        output = run_interview(provider, prompter, known, draft=draft, changes=changes, provider_path=provider_path)
        draft = json.dumps(output)
        try:
            answers = Draft.from_output(output)
            problems = draft_problems(answers)
        except KeyError as exc:
            problems = [f"the result was missing {exc.args[0]}"]
        except TypeError:
            problems = ["the result had the wrong shape"]
        if problems:
            failed += 1
            if failed == TRIES:
                raise OnboardError(f"the interview didn't settle on a company: {clean('; '.join(problems))}")
            changes = "\n".join(problems)
            continue
        for line in summary(answers):
            prompter.say(line)
        reply = prompter.ask(CONFIRM).strip()
        if reply.lower() in ("", "y", "yes"):
            return answers
        changes = ("The owner wants changes; ask what to change" if reply.lower() in ("n", "no")
                   else f"The owner wants changes: {reply}")

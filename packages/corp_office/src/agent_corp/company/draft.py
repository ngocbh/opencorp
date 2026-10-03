"""A proposed company, as the owner's interview drafts it, and what's wrong with it."""

from dataclasses import dataclass

from pydantic import ValidationError

from agent_corp.company.naming import handle_problem
from agent_corp.company_template import Owner, template_files
from agent_corp.protocol.models import HireRequest


@dataclass(frozen=True)
class Teammate:
    """A first teammate: an agent reporting to the CEO, with a sentence that seeds their profile."""

    name: str
    handle: str
    title: str
    about: str = ""


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


def field_problems(answers: Answers) -> list[tuple[str | None, str]]:
    """Each problem with answers, after the field it is about (company, owner.name, owner.handle, teammate.name,
    teammate.title or teammate.handle), or None when it is about the whole."""
    owner = answers.owner
    found: list[tuple[str | None, str]] = []
    if not answers.company.strip():
        found.append(("company", "the company needs a name"))
    if not owner.name.strip():
        found.append(("owner.name", "the owner needs a name"))
    if why := handle_problem(owner.handle):
        found.append(("owner.handle", f"@{owner.handle} can't be a handle: {why}"))
    if not found:
        try:
            template_files(answers.company, owner)  # validates without writing
        except ValueError as exc:
            found.append((None, f"that company doesn't work: {exc}"))
    taken = {owner.handle}
    for t in answers.team:
        mine: list[tuple[str | None, str]] = []
        if not t.name.strip():
            mine.append(("teammate.name", f"the teammate @{t.handle} needs a name"))
        if not t.title.strip():
            mine.append(("teammate.title", f"the teammate @{t.handle} needs a title"))
        if why := handle_problem(t.handle):
            mine.append(("teammate.handle", f"@{t.handle} can't be a handle: {why}"))
        elif t.handle in taken:
            mine.append(("teammate.handle", f"@{t.handle} is taken"))
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
    return [why for _, why in field_problems(answers)]

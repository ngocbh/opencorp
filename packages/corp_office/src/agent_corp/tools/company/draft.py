"""Tools for drafting a new company, which `ac init`'s flow does before the company exists; no office group has
them."""

from typing import TypedDict

from agent_corp.company.draft import Draft, Teammate, draft_problems
from agent_corp.company_template import Owner


class CheckOwner(TypedDict, total=False):
    """The owner, as ``check_company`` takes it; a missing field is checked as empty."""

    name: str
    handle: str
    title: str


class CheckTeammate(TypedDict, total=False):
    """A teammate, as ``check_company`` takes it; a missing field is checked as empty."""

    name: str
    handle: str
    title: str


def check_company(company: str = "", owner: CheckOwner | None = None,
                  teammates: list[CheckTeammate] | None = None) -> str:
    """Check a company before you return it: its name, the owner, and the first teammates.

    Returns "No problems." or the problems to fix with the owner.
    """
    # The docstring is the tool description the model reads. Every argument is optional because composer fails the
    # whole run on a call that misses a required one; a gap is a problem for the model to fix instead.
    owner = owner or {}
    draft = Draft(company, Owner(handle=owner.get("handle", ""), name=owner.get("name", ""),
                                 title=owner.get("title", "")),
                  tuple(Teammate(t.get("name", ""), t.get("handle", ""), t.get("title", "")) for t in teammates or []))
    if problems := draft_problems(draft):
        return "Problems; ask the owner how to fix each, then check again:\n" + "\n".join(f"- {p}" for p in problems)
    return "No problems."

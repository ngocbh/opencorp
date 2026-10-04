"""Who a person is and who they're talking with, as inputs their chat flows render into the reply's system prompt."""

from agent_corp.company.loader import CompanyRepo
from agent_corp.protocol.models import Person


def person_inputs(repo: CompanyRepo, person: Person) -> dict[str, str]:
    """The ``person`` flow input: name, handle, title, company, and a sentence naming their manager.

    ``company`` is ``""`` without a company. ``reports_to`` is ``""`` when the person has no
    manager or the manager isn't in the repo; flow templates have no conditionals, so the
    office hands them a whole sentence or nothing.
    """
    manager = repo.people.get(person.manager) if person.manager else None
    return {
        "name": person.name,
        "handle": person.handle,
        "title": person.title,
        "company": repo.company.name if repo.company else "",
        "reports_to": f"You report to {manager.name} (@{manager.handle})." if manager else "",
    }


def talking_to(repo: CompanyRepo, person: Person, opened_by: str | None) -> str:
    """The ``talking_to`` flow input: a sentence naming the human in the chat and how they relate to ``person``.

    The human is ``opened_by``, or the CEO for a session that doesn't record who opened it.
    ``""`` when that human isn't in the repo or is ``person``. The roles come from the org
    chart: the CEO, then one of your manager, your direct report, or your peer.
    """
    ceo = repo.company.ceo if repo.company else None
    handle = opened_by or ceo
    human = repo.people.get(handle) if handle else None
    if human is None or human.handle == person.handle:
        return ""
    roles = ["the CEO"] if human.handle == ceo else []
    if person.manager == human.handle:
        roles.append("your manager")
    elif human.manager == person.handle:
        roles.append("your direct report")
    elif human.manager and human.manager == person.manager:
        roles.append("your peer")
    said = f", {' and '.join(roles)}" if roles else ""
    return f"You're talking with {human.name} (@{human.handle}){said}."

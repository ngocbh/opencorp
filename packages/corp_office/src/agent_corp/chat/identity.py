"""Who a person is, as the inputs their chat flows render into the reply's system prompt."""

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

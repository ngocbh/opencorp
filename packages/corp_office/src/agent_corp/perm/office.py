"""Who may add, remove or change the default of this office's model connections."""

from agent_corp.company.loader import CompanyRepo
from agent_corp.perm.monitor import _grants, _subjects

TOOL = "connections"
"""The grant, on an asset of kind ``office``, that lets a person manage connections."""


def may_manage_connections(repo: CompanyRepo, person: str, *, owner: str | None) -> bool:
    """Whether ``person`` may manage connections: the office's ``owner`` (the CEO while it has none), or someone
    granted ``connections`` or ``admin`` on an asset of kind ``office``.

    Advisory: anyone sharing the office's OS user can read its files.
    """
    if person == (owner or (repo.company.ceo if repo.company else None)):
        return True
    subjects = _subjects(repo, person)
    return any(a.kind == "office" and _grants(a, TOOL, subjects) for a in repo.assets.values())

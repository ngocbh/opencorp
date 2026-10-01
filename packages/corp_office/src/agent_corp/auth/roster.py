"""Who may act: the CEO and the humans' device token hashes at the company repo's HEAD."""

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field

import yaml
from pydantic import BaseModel, ValidationError

from agent_corp.company.git import CompanyGit
from agent_corp.protocol.models import Company, Person


@dataclass(frozen=True)
class Roster:
    """The CEO and ``{token_sha256: (handle, device)}`` at commit ``head``."""

    head: str
    ceo: str | None
    tokens: dict[str, tuple[str, str]] = field(default_factory=dict)
    enforced: bool = False
    """Whether every request needs a token: once any human lists a device."""

    @classmethod
    def of(cls, head: str, ceo: str | None, people: Iterable[Person]) -> "Roster":
        """The roster of ``people`` at ``head``."""
        people = list(people)
        return cls(head, ceo, token_table(people), any(p.kind == "human" and p.devices for p in people))


def token_table(people: Iterable[Person]) -> dict[str, tuple[str, str]]:
    """``{token_sha256: (handle, device)}`` over the humans' devices.

    Agents' devices are ignored, and a hash two people list is left out: it can't say who acts.
    """
    owners: dict[str, dict[str, str]] = defaultdict(dict)
    for person in people:
        if person.kind == "human":
            for device in person.devices:
                owners[device.token_sha256].setdefault(person.handle, device.name)
    return {h: next(iter(by.items())) for h, by in owners.items() if len(by) == 1}


def _parse[M: BaseModel](git: CompanyGit, blob: str | None, model: type[M]) -> M | None:
    data = git.read_blob(blob) if blob else None
    try:
        return model.model_validate(yaml.safe_load(data)) if data else None
    except (ValidationError, yaml.YAMLError, UnicodeDecodeError):
        return None  # lint reports a broken file; here it just lets no one in through it


def load_roster(git: CompanyGit, head: str) -> Roster:
    """The roster at commit ``head``, read from git objects, so uncommitted edits don't count."""
    company = _parse(git, git.blob_id("company.yaml", head), Company)
    people: list[Person] = []
    for path, blob in git.files("people", head).items():
        parts = path.split("/")
        if len(parts) == 3 and parts[2] == "person.yaml":
            person = _parse(git, blob, Person)
            if person is not None and person.handle == parts[1]:
                people.append(person)
    return Roster.of(head, company.ceo if company else None, people)

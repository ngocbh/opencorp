"""Who may act: the CEO and the humans' device token hashes at the company repo's HEAD."""

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field

import yaml
from pydantic import BaseModel, ValidationError

from opencorp.company.git import CompanyGit
from opencorp.protocol.models import Company, Person


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


def _parse[M: BaseModel](data: bytes | None, model: type[M]) -> M | None:
    try:
        return model.model_validate(yaml.safe_load(data)) if data else None
    except (ValidationError, yaml.YAMLError, UnicodeDecodeError):
        return None  # lint reports a broken file; here it just lets no one in through it


def load_roster(git: CompanyGit, head: str) -> Roster:
    """The roster at commit ``head``, read from git objects, so uncommitted edits don't count."""
    company_blob = git.blob_id("company.yaml", head)
    person_blobs = {path.split("/")[1]: blob for path, blob in git.files("people", head).items()
                    if path.count("/") == 2 and path.endswith("/person.yaml")}
    # One read for every file: a git call per person would make each reload grow with the company.
    data = git.read_blobs([b for b in (company_blob, *person_blobs.values()) if b])
    company = _parse(data.get(company_blob or ""), Company)
    people = [p for handle, blob in person_blobs.items()
              if (p := _parse(data.get(blob), Person)) is not None and p.handle == handle]
    return Roster.of(head, company.ceo if company else None, people)

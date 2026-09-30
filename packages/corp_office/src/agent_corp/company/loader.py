"""Load a company repo into validated protocol models."""

from dataclasses import dataclass, field
from pathlib import Path

import yaml
from pydantic import BaseModel, ValidationError

from agent_corp.company.issues import RepoIssue
from agent_corp.protocol.models import Asset, Company, Group, Person


@dataclass(frozen=True)
class CompanyRepo:
    """One company repo checkout, parsed. Files that fail to parse are in ``errors``."""

    root: Path
    company: Company | None
    people: dict[str, Person] = field(default_factory=dict)
    groups: dict[str, Group] = field(default_factory=dict)
    assets: dict[str, Asset] = field(default_factory=dict)
    errors: list[RepoIssue] = field(default_factory=list)


def _parse[M: BaseModel](root: Path, rel: Path, model: type[M], errors: list[RepoIssue]) -> M | None:
    """Parse one YAML file into ``model``; record a problem and return None on failure."""
    try:
        return model.model_validate(yaml.safe_load((root / rel).read_text(encoding="utf-8")))
    except ValidationError as exc:  # a ValueError subclass, so it must come first
        errors.append(RepoIssue(str(rel), "repo.schema", str(exc)))
    except (OSError, UnicodeDecodeError, yaml.YAMLError) as exc:
        errors.append(RepoIssue(str(rel), "repo.unreadable", str(exc)))
    return None


def load_repo(root: Path) -> CompanyRepo:
    """Parse ``company.yaml``, people, groups, and assets under ``root``."""
    root = root.resolve()
    errors: list[RepoIssue] = []
    company = _parse(root, Path("company.yaml"), Company, errors)
    people: dict[str, Person] = {}
    for rel in sorted(p.relative_to(root) for p in root.glob("people/*/person.yaml")):
        if (person := _parse(root, rel, Person, errors)) is None:
            continue
        if person.id != rel.parent.name:
            errors.append(RepoIssue(str(rel), "person.dir_mismatch",
                                    f"id {person.id!r} must match its directory {rel.parent.name!r}"))
        else:
            people[person.id] = person
    groups: dict[str, Group] = {}
    assets: dict[str, Asset] = {}
    for pattern, model, into in (("groups/*.yaml", Group, groups), ("assets/*.yaml", Asset, assets)):
        for rel in sorted(p.relative_to(root) for p in root.glob(pattern)):
            if (item := _parse(root, rel, model, errors)) is None:
                continue
            if item.id != rel.stem:
                errors.append(RepoIssue(str(rel), "repo.file_mismatch",
                                        f"id {item.id!r} must match its file name {rel.stem!r}"))
            else:
                into[item.id] = item
    return CompanyRepo(root, company, people, groups, assets, errors)

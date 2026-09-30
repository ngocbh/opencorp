"""The files a new company repo starts from, and ``write_company``, which lays them down.

Everything in this package except Python files is a template file, at the same path in the
repo. ``company.yaml`` and ``people/{owner}/person.yaml`` are filled in with the company name
and the owner; the rest (the shared flows) are copied as they are.
"""

import json
import os
import subprocess
from dataclasses import dataclass
from importlib.resources import files
from importlib.resources.abc import Traversable
from pathlib import Path
from string import Template

import yaml
from pydantic import ValidationError

from agent_corp.company.git import CompanyGit
from agent_corp.protocol.models import Company, Person

_OWNER_DIR = "people/{owner}"
_FILLED = ("company.yaml", f"{_OWNER_DIR}/person.yaml")


@dataclass(frozen=True)
class Owner:
    """The human who onboards: the company's CEO."""

    id: str
    handle: str
    name: str
    title: str = "CEO"


def _walk(node: Traversable, prefix: str = "") -> dict[str, bytes]:
    found: dict[str, bytes] = {}
    for child in node.iterdir():
        rel = f"{prefix}{child.name}"
        if child.is_dir():
            if child.name != "__pycache__":
                found |= _walk(child, f"{rel}/")
        elif not child.name.endswith((".py", ".pyc")):
            found[rel] = child.read_bytes()
    return found


def template_files(company: str, owner: Owner) -> dict[str, bytes]:
    """Every file of a new company repo by repo path, with ``company.yaml`` and the owner's file filled in.

    Raises:
        ValueError: the company name or the owner doesn't make a valid ``Company`` or ``Person``.
    """
    # JSON strings are YAML double-quoted scalars, so any name survives the substitution.
    values = {k: json.dumps(v) for k, v in {"company": company, "ceo": owner.id, "id": owner.id,
                                            "handle": owner.handle, "name": owner.name,
                                            "title": owner.title}.items()}
    out: dict[str, bytes] = {}
    for rel, data in _walk(files(__name__)).items():
        if rel in _FILLED:
            text = Template(data.decode()).substitute(values)
            model = Company if rel == "company.yaml" else Person
            try:
                model.model_validate(yaml.safe_load(text))
            except ValidationError as exc:
                raise ValueError(f"{rel}: {exc}") from None
            data = text.encode()
        out[rel.replace(_OWNER_DIR, f"people/{owner.id}", 1)] = data
    return out


def _git_init(root: Path) -> None:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env |= {"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}
    subprocess.run(["git", "init", "-q", "-b", "main", str(root)], check=True, capture_output=True, env=env)


def write_company(root: Path, worktrees: Path, *, company: str | None = None,
                  owner: Owner | None = None) -> list[str]:
    """Create or top up the company repo at ``root``; return the repo paths written, sorted.

    A missing repo is created (``git init``) from the template. An existing one gets only the
    template files it lacks, such as flows added to the template after it was made: nothing
    is overwritten, so the owner's edits stay. Only what was written is committed.
    ``company`` and ``owner`` are needed only while ``company.yaml`` is missing.

    Raises:
        ValueError: ``company.yaml`` is missing and ``company`` or ``owner`` is not given or
            not valid. Nothing is written.
    """
    new = not (root / "company.yaml").exists()
    if not new:
        wanted = {rel: data for rel, data in _walk(files(__name__)).items() if rel not in _FILLED}
    elif company is None or owner is None:
        raise ValueError(f"{root} has no company.yaml; a new company needs a name and an owner")
    else:
        wanted = template_files(company, owner)
    missing = sorted(rel for rel in wanted if not os.path.lexists(root / rel))
    if not (root / ".git").exists():
        root.mkdir(parents=True, exist_ok=True)
        _git_init(root)
    for rel in missing:
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(wanted[rel])
    CompanyGit(root, worktrees).commit(missing, "onboard: create the company" if new else "onboard: add template files")
    return missing

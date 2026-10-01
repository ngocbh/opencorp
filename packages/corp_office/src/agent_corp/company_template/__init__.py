"""The files a new company repo starts from, and ``write_company``, which lays them down.

Everything in this package except Python files is a template file, at the same path in the
repo. ``company.yaml`` and ``people/{owner}/person.yaml`` are filled in with the company name
and the owner; the rest (the shared flows) are copied as they are.
"""

import json
import os
import subprocess
from dataclasses import dataclass, field
from importlib.resources import files
from importlib.resources.abc import Traversable
from pathlib import Path
from string import Template

import yaml
from pydantic import ValidationError

from agent_corp.company.git import CompanyGit, CompanyGitError
from agent_corp.protocol.models import Company, Device, Person

_OWNER_DIR = "people/{owner}"
_FILLED = ("company.yaml", f"{_OWNER_DIR}/person.yaml")


@dataclass(frozen=True)
class Owner:
    """The human who onboards: the company's CEO."""

    handle: str
    name: str
    title: str = "CEO"
    devices: tuple[Device, ...] = field(default=())
    """The devices the owner's first ``person.yaml`` lists."""


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
    values = {k: json.dumps(v) for k, v in {"company": company, "ceo": owner.handle, "handle": owner.handle,
                                            "name": owner.name, "title": owner.title}.items()}
    out: dict[str, bytes] = {}
    for rel, data in _walk(files(__name__)).items():
        if rel in _FILLED:
            text = Template(data.decode()).substitute(values)
            if rel != "company.yaml" and owner.devices:
                text += "devices:\n" + "".join(f"- name: {json.dumps(d.name)}\n"
                                               f"  token_sha256: {json.dumps(d.token_sha256)}\n"
                                               for d in owner.devices)
            model = Company if rel == "company.yaml" else Person
            try:
                model.model_validate(yaml.safe_load(text))
            except ValidationError as exc:
                raise ValueError(f"{rel}: {exc}") from None
            data = text.encode()
        out[rel.replace(_OWNER_DIR, f"people/{owner.handle}", 1)] = data
    return out


def missing_files(root: Path) -> list[str]:
    """The template files an existing company repo at ``root`` lacks, sorted: what ``write_company`` would add."""
    return sorted(rel for rel in _walk(files(__name__)) if rel not in _FILLED and not os.path.lexists(root / rel))


def _git_init(root: Path) -> None:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env |= {"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}
    try:
        subprocess.run(["git", "init", "-q", "-b", "main", str(root)], check=True, capture_output=True, text=True,
                       env=env)
    except OSError as exc:
        raise CompanyGitError(f"can't run git: {exc.strerror or exc}") from None
    except subprocess.CalledProcessError as exc:
        raise CompanyGitError(f"git init {root} exited {exc.returncode}: {exc.stderr.strip()}") from None


def is_new(root: Path) -> bool:
    """Whether ``root`` has no company yet: no ``company.yaml``, or no commit (a first write that stopped early)."""
    if not (root / "company.yaml").exists() or not (root / ".git").exists():
        return True
    try:
        CompanyGit(root, root).head()
    except ValueError:
        return True
    return False


def _stopped_owner(root: Path) -> str | None:
    """The CEO in a new repo's ``company.yaml`` (an earlier, interrupted write's owner), or None if it doesn't say."""
    try:
        ceo = yaml.safe_load((root / "company.yaml").read_text()).get("ceo")
        # The handle pattern allows no '/' or '.', so the handle names a directory directly under people/.
        Company.model_validate({"name": "-", "ceo": ceo})
    except (OSError, UnicodeDecodeError, yaml.YAMLError, AttributeError, ValidationError):
        return None
    return ceo


def write_company(root: Path, worktrees: Path, *, company: str | None = None,
                  owner: Owner | None = None) -> list[str]:
    """Create or top up the company repo at ``root``; return the repo paths written, sorted.

    A new repo (see ``is_new``) is created (``git init``) from the template, and every
    template path in it is committed, so a first write that stopped part way is finished;
    ``company.yaml`` and the owner's file are always rewritten from the answers given, and
    the owner file of the CEO the old ``company.yaml`` names, if it is someone else, is removed.
    An existing one gets only the template files it lacks, such as flows added to the
    template after it was made: nothing is overwritten, so the owner's edits stay. Only
    what was written is committed. ``company`` and ``owner`` are needed only for a new repo.

    Raises:
        ValueError: the repo is new and ``company`` or ``owner`` is not given or not
            valid. Nothing is written.
        CompanyGitError: git is missing or failed.
    """
    new = is_new(root)
    if not new:
        wanted = {rel: data for rel, data in _walk(files(__name__)).items() if rel not in _FILLED}
        filled: set[str] = set()
        stale = None
    elif company is None or owner is None:
        raise ValueError(f"{root} has no company yet; a new company needs a name and an owner")
    else:
        wanted = template_files(company, owner)
        # Nothing is committed yet, so an earlier, interrupted write's filled files are stale or partial.
        filled = {rel.replace(_OWNER_DIR, f"people/{owner.handle}", 1) for rel in _FILLED}
        stale = _stopped_owner(root)
        stale = None if stale == owner.handle else stale
    missing = sorted(rel for rel in wanted if rel in filled or not os.path.lexists(root / rel))
    if not (root / ".git").exists():
        root.mkdir(parents=True, exist_ok=True)
        _git_init(root)
    for rel in missing:
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(wanted[rel])
    # The interrupted write's owner file, under a handle since changed; nothing else there is
    # ours, and a symlinked directory isn't one onboard made.
    if stale is not None and not any(p.is_symlink() for p in (root / "people", root / "people" / stale)):
        (root / "people" / stale / "person.yaml").unlink(missing_ok=True)
        try:
            (root / "people" / stale).rmdir()
        except OSError:  # gone, or holds something onboard didn't write
            pass
    # A new repo commits everything present: files an earlier, interrupted write left uncommitted too.
    commit = sorted(rel for rel in wanted if os.path.lexists(root / rel)) if new else missing
    CompanyGit(root, worktrees).commit(commit, "onboard: create the company" if new else "onboard: add template files")
    return missing

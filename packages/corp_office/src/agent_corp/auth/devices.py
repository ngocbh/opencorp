"""Adding and removing a human's devices in their ``person.yaml``, one commit each."""

import yaml
from pydantic import ValidationError

from agent_corp.company.git import CompanyGit
from agent_corp.company.loader import CompanyRepo, load_repo
from agent_corp.protocol.models import Device, Person


class DeviceRefused(Exception):
    """A device change that can't be made: ``status`` and ``code`` are the HTTP error's."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _person(repo: CompanyRepo, handle: str, actor: str) -> Person:
    """The human ``handle``, if ``actor`` may change their devices: themselves, or the CEO for anyone."""
    person = repo.people.get(handle)
    if person is None:
        raise DeviceRefused(404, "not_found", f"no person @{handle}")
    if person.kind != "human":
        raise DeviceRefused(422, "not_a_human", f"@{handle} is an agent; only humans have devices")
    ceo = repo.company.ceo if repo.company else None
    if actor not in (handle, ceo):
        raise DeviceRefused(403, "forbidden", f"only @{handle} or the CEO can change @{handle}'s devices")
    return person


def _write(git: CompanyGit, handle: str, devices: list[Device], subject: str) -> Person:
    """Set ``handle``'s devices in their ``person.yaml`` and commit it; the file is restored if that fails."""
    rel = f"people/{handle}/person.yaml"
    path = git.root / rel
    before = path.read_bytes()
    data = yaml.safe_load(before)
    if devices:
        data["devices"] = [d.model_dump() for d in devices]
    else:
        data.pop("devices", None)
    try:
        person = Person.model_validate(data)
    except ValidationError as exc:
        raise DeviceRefused(422, "invalid_body", str(exc)) from None
    try:
        path.write_text(yaml.safe_dump(data, sort_keys=False))
        git.commit([rel], subject)
    except BaseException:
        path.write_bytes(before)
        raise
    return person


def add_device(git: CompanyGit, handle: str, device: Device, actor: str) -> Person:
    """Add ``device`` to ``handle``'s devices as ``actor``; the same name and hash again changes nothing.

    Raises:
        DeviceRefused: 409 ``device_exists`` for the name with another hash; 409 ``token_in_use``
            for a hash someone already lists, since the office can't tell who it acts as.
    """
    with git.lock:
        git.commit_hand_edits()
        repo = load_repo(git.root)
        person = _person(repo, handle, actor)
        for d in person.devices:
            if d.name == device.name:
                if d.token_sha256 == device.token_sha256:
                    return person
                raise DeviceRefused(409, "device_exists", f"@{handle} already has a device named {device.name}")
        if any(d.token_sha256 == device.token_sha256 for p in repo.people.values() for d in p.devices):
            raise DeviceRefused(409, "token_in_use", "another device already lists this token")
        return _write(git, handle, [*person.devices, device], f"devices(@{handle}): add {device.name}")


def remove_device(git: CompanyGit, handle: str, name: str, actor: str) -> Person:
    """Remove the device ``name`` from ``handle``'s devices as ``actor``.

    Removing the last device of the last human with one turns enforcement off again.
    """
    with git.lock:
        git.commit_hand_edits()
        person = _person(load_repo(git.root), handle, actor)
        kept = [d for d in person.devices if d.name != name]
        if len(kept) == len(person.devices):
            raise DeviceRefused(404, "not_found", f"@{handle} has no device named {name}")
        return _write(git, handle, kept, f"devices(@{handle}): remove {name}")

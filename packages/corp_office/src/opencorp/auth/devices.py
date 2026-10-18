"""Changing a human's devices and password in their ``person.yaml``, one commit each."""

import yaml
from pydantic import ValidationError

from opencorp.auth.passwords import check_password, hash_password, password_problem
from opencorp.company.git import CompanyGit
from opencorp.company.loader import CompanyRepo, load_repo
from opencorp.protocol.models import Device, LoginRequest, Person


class DeviceRefused(Exception):
    """A device or password change that can't be made: ``status`` and ``code`` are the HTTP error's."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _person(repo: CompanyRepo, handle: str, actor: str, what: str = "devices") -> Person:
    """The human ``handle``, if ``actor`` may change their ``what``: themselves, or the CEO for anyone."""
    person = repo.people.get(handle)
    if person is None:
        raise DeviceRefused(404, "not_found", f"no person @{handle}")
    if person.kind != "human":
        raise DeviceRefused(422, "not_a_human", f"@{handle} is an agent; agents have no {what}")
    ceo = repo.company.ceo if repo.company else None
    if actor not in (handle, ceo):
        raise DeviceRefused(403, "forbidden", f"only @{handle} or the CEO can change @{handle}'s {what}")
    return person


def _write(git: CompanyGit, handle: str, key: str, value: object, subject: str) -> Person:
    """Set ``key`` in ``handle``'s ``person.yaml`` (an empty ``value`` drops it) and commit it; the file is
    restored if that fails."""
    rel = f"people/{handle}/person.yaml"
    path = git.root / rel
    before = path.read_bytes()
    data = yaml.safe_load(before)
    if value:
        data[key] = value
    else:
        data.pop(key, None)
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
        return _write(git, handle, "devices", [d.model_dump() for d in [*person.devices, device]],
                      f"devices(@{handle}): add {device.name}")


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
        return _write(git, handle, "devices", [d.model_dump() for d in kept], f"devices(@{handle}): remove {name}")


def login(git: CompanyGit, request: LoginRequest) -> Person:
    """Add ``request``'s device to its human's devices once their password checks out.

    Raises:
        DeviceRefused: 401 ``bad_login`` for an unknown handle, an agent or a wrong password, told
            apart by no one; 409 ``no_password`` for a human without a password; or what
            ``add_device`` raises.
    """
    with git.lock:
        person = load_repo(git.root).people.get(request.handle)
    if person is not None and person.kind == "human" and person.password_hash is None:
        raise DeviceRefused(409, "no_password", f"@{request.handle} has no password; set one with `opencorp password`")
    if person is None or person.kind != "human" or not check_password(request.password, person.password_hash):
        raise DeviceRefused(401, "bad_login", "wrong handle or password")
    device = Device(name=request.device, token_sha256=request.token_sha256)
    return add_device(git, request.handle, device, request.handle)


def set_password(git: CompanyGit, handle: str, password: str, actor: str) -> Person:
    """Set ``handle``'s password as ``actor``, keeping only its hash.

    Raises:
        DeviceRefused: 422 ``invalid_body`` for a password too short to be one; or what changing a
            person refuses.
    """
    if (problem := password_problem(password)) is not None:
        raise DeviceRefused(422, "invalid_body", problem)
    password_hash = hash_password(password)  # slow on purpose, so outside the lock
    with git.lock:
        git.commit_hand_edits()
        _person(load_repo(git.root), handle, actor, "password")
        return _write(git, handle, "password_hash", password_hash, f"password(@{handle}): set")

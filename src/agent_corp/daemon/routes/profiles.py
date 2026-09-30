"""Profile routes: read and edit a person's profile.md through the office's MarkdownStore."""

from agent_composer.memory.storage.markdown import MarkdownStore, MarkdownVersionMismatch
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from agent_corp.company.loader import load_repo
from agent_corp.daemon.http import HTTPError, call, get_office, ok, parse
from agent_corp.protocol.models import CompanyDefaults, Profile, ProfileWriteRequest, VersionConflict


async def _open(request: Request) -> tuple[str, MarkdownStore, int]:
    """The person id, their profile store, and the profile budget in characters."""
    office = get_office(request)
    if office.profile_store is None:
        raise HTTPError(501, "not_implemented", f"{request.method} {request.url.path} is not implemented yet")
    pid = request.path_params["person"]
    repo = await call(load_repo, office.git.root)
    if pid not in repo.people:
        raise HTTPError(404, "not_found", f"no person {pid}")
    defaults = (repo.company.defaults if repo.company else None) or CompanyDefaults()
    return pid, office.profile_store(pid), defaults.profile_max_chars


async def get_profile(request: Request) -> JSONResponse:
    """A person's profile text and version."""
    pid, store, max_chars = await _open(request)
    text, version = await call(store.read)
    return ok(Profile(person=pid, text=text, version=version, over_budget=len(text) > max_chars))


async def put_profile(request: Request) -> JSONResponse:
    """Replace a profile if ``base_version`` is current; ``409`` with both versions if not."""
    body = await parse(request, ProfileWriteRequest)
    pid, store, max_chars = await _open(request)
    try:
        version = await call(store.write, body.text, base_version=body.base_version, provenance={"source": "edit"})
    except MarkdownVersionMismatch as exc:
        conflict = VersionConflict(expected=exc.expected, current=exc.current)
        return JSONResponse(conflict.model_dump(mode="json"), status_code=409)
    profile = Profile(person=pid, text=body.text, version=version, over_budget=len(body.text) > max_chars)
    await call(get_office(request).store.emit, "profile.updated", pid, profile)
    return ok(profile)


ROUTES = [
    Route("/profiles/{person}", get_profile, methods=["GET"]),
    Route("/profiles/{person}", put_profile, methods=["PUT"]),
]

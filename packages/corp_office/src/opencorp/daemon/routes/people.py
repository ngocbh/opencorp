"""People routes: the roster, who worked in a folder, and hiring."""

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from opencorp.chat.hire import HireRefused, Hiring
from opencorp.company.loader import load_repo
from opencorp.daemon.http import HTTPError, call, get_office, ok, parse
from opencorp.protocol.models import HireRequest, Person


def served(person: Person) -> Person:
    """``person`` as the API shows them: without their password hash, which only the company repo holds."""
    return person.model_copy(update={"password_hash": None})


async def list_people(request: Request) -> JSONResponse:
    """Everyone in the company repo."""
    repo = await call(load_repo, get_office(request).git.root)
    return ok([served(p) for p in repo.people.values()])


async def folder_people(request: Request) -> JSONResponse:
    """People who worked in a folder, most recent first."""
    office = get_office(request)
    cwd = request.path_params["cwd"]
    repo = await call(load_repo, office.git.root)

    def last_worked() -> list[tuple[str, str]]:
        found = []
        for handle in repo.people:
            # -1 is SQLite's "no limit": the folder may be far down a busy person's list.
            for folder in office.store.worked_folders(handle, limit=-1):
                if folder.cwd == cwd:
                    found.append((folder.last_at, handle))
        return found

    found = await call(last_worked)
    found.sort(key=lambda f: f[1])
    found.sort(key=lambda f: f[0], reverse=True)  # stable: ties stay in handle order
    return ok([served(repo.people[handle]) for _, handle in found])


async def hire(request: Request) -> JSONResponse:
    """Preview a hire (writes nothing, lint issues included), or confirm the preview and commit it."""
    hiring: Hiring | None = get_office(request).extras.get("hiring")
    if hiring is None:
        raise HTTPError(501, "not_implemented", f"{request.method} {request.url.path} is not implemented yet")
    body = await parse(request, HireRequest)
    try:
        return ok(await call(hiring.hire, body))
    except HireRefused as exc:
        raise HTTPError(422, exc.code, exc.message) from exc


ROUTES = [
    Route("/people", list_people, methods=["GET"]),
    Route("/people", hire, methods=["POST"]),
    Route("/folders/{cwd:path}/people", folder_people, methods=["GET"]),
]

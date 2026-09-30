"""People routes: the roster and who worked in a folder."""

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from agent_corp.company.loader import load_repo
from agent_corp.daemon.http import call, get_office, not_implemented, ok


async def list_people(request: Request) -> JSONResponse:
    """Everyone in the company repo."""
    repo = await call(load_repo, get_office(request).git.root)
    return ok(list(repo.people.values()))


async def folder_people(request: Request) -> JSONResponse:
    """People who worked in a folder, most recent first."""
    office = get_office(request)
    cwd = request.path_params["cwd"]
    repo = await call(load_repo, office.git.root)

    def last_worked() -> list[tuple[str, str]]:
        found = []
        for pid in repo.people:
            # -1 is SQLite's "no limit": the folder may be far down a busy person's list.
            for folder in office.store.worked_folders(pid, limit=-1):
                if folder.cwd == cwd:
                    found.append((folder.last_at, pid))
        return found

    found = await call(last_worked)
    found.sort(key=lambda f: f[1])
    found.sort(key=lambda f: f[0], reverse=True)  # stable: ties stay in id order
    return ok([repo.people[pid] for _, pid in found])


ROUTES = [
    Route("/people", list_people, methods=["GET"]),
    Route("/people", not_implemented, methods=["POST"]),
    Route("/folders/{cwd:path}/people", folder_people, methods=["GET"]),
]

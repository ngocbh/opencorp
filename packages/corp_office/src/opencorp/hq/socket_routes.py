"""HQ's routes on the office socket, which HQ's listeners never mount: status, one-time links, browser sessions."""

from __future__ import annotations

from typing import TYPE_CHECKING

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from opencorp.daemon.auth import acting_person
from opencorp.daemon.http import HTTPError, call, get_office, ok, parse
from opencorp.protocol.models import Ack, CompanyView, PairCodeRequest

if TYPE_CHECKING:
    from opencorp.hq.core import Hq


def _hq(request: Request) -> Hq:
    found = get_office(request).extras.get("hq")
    if found is None:
        raise HTTPError(501, "not_implemented", f"{request.method} {request.url.path} is not implemented yet")
    return found


def _for(view: CompanyView | None, handle: str, actor: str) -> None:
    """Refuse unless ``handle`` is a human at HEAD and ``actor`` is them or the CEO (the rule for devices)."""
    person = next((p for p in view.people if p.handle == handle), None) if view else None
    if person is None:
        raise HTTPError(404, "not_found", f"no person @{handle}")
    if person.kind != "human":
        raise HTTPError(422, "not_a_human", f"@{handle} is an agent; agents don't sign in to HQ")
    ceo = view.company.ceo if view and view.company else None
    if actor not in (handle, ceo):
        raise HTTPError(403, "forbidden", f"only @{handle} or the CEO can do this for @{handle}")


async def status(request: Request) -> JSONResponse:
    """Where HQ listens, and its health."""
    return ok(_hq(request).status())


async def pair(request: Request) -> JSONResponse:
    """A one-time link that signs a browser in as ``handle`` (the asking person by default).

    In no-device mode the asking person is the CEO; pairing writes no ``person.yaml``, so enforcement doesn't change.
    """
    hq = _hq(request)
    body = await parse(request, PairCodeRequest)
    actor = acting_person(request)
    handle = body.handle or actor
    _for(await hq.snapshots.head(), handle, actor)
    return ok(await hq.mint(handle, issuer=actor, open_file=body.open_file))


async def browsers(request: Request) -> JSONResponse:
    """A person's browser sessions on this office, newest first.

    A person who left the company can't be listed (404): their sessions fail the check and are deleted on first use,
    and expired ones are pruned at office start and on each new session.
    """
    hq = _hq(request)
    actor = acting_person(request)
    handle = request.query_params.get("person") or actor
    _for(await hq.snapshots.head(), handle, actor)
    return ok([r.public() for r in await call(hq.office.store.list_hq_sessions, handle)])


async def remove_browser(request: Request) -> JSONResponse:
    """End one browser session, its open streams included."""
    hq = _hq(request)
    record = await call(hq.office.store.get_hq_session, request.path_params["id"])
    if record is None:
        raise HTTPError(404, "not_found", f"no browser session {request.path_params['id']}")
    _for(await hq.snapshots.head(), record.person, acting_person(request))
    await hq.sessions.revoke(record.id)
    return ok(Ack(ok=True))


ROUTES = [
    Route("/hq", status, methods=["GET"]),
    Route("/hq/pair", pair, methods=["POST"]),
    Route("/hq/browsers", browsers, methods=["GET"]),
    Route("/hq/browsers/{id}", remove_browser, methods=["DELETE"]),
]

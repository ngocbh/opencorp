"""Identity routes: the office's liveness probe, who a request acts as, logging in, and humans'
devices and passwords."""

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from agent_corp.auth.devices import DeviceRefused, add_device, login, remove_device, set_password
from agent_corp.daemon.auth import acting_device, acting_person
from agent_corp.daemon.http import HTTPError, call, get_office, ok, parse
from agent_corp.daemon.routes.people import served
from agent_corp.protocol.models import AddDeviceRequest, Device, LoginRequest, Person, SetPasswordRequest


async def health(request: Request) -> JSONResponse:
    """``{"ok": true}``: the office is answering. Served without a token."""
    return JSONResponse({"ok": True})


async def whoami(request: Request) -> JSONResponse:
    """``{"person": handle, "device": name | null}``: who this request acts as, and from which device."""
    return JSONResponse({"person": acting_person(request), "device": acting_device(request)})


async def _refusable(change, *args) -> Person:
    try:
        return served(await call(change, *args))
    except DeviceRefused as exc:
        raise HTTPError(exc.status, exc.code, exc.message) from exc


async def _change(request: Request, change, arg) -> Person:
    return await _refusable(change, get_office(request).git, request.path_params["handle"], arg, acting_person(request))


async def add(request: Request) -> JSONResponse:
    """Add a device to a human's ``person.yaml`` and commit it; the person afterwards."""
    body = await parse(request, AddDeviceRequest)
    return ok(await _change(request, add_device, Device(**body.model_dump())))


async def remove(request: Request) -> JSONResponse:
    """Remove a device, by name, from a human's ``person.yaml`` and commit it; the person afterwards."""
    return ok(await _change(request, remove_device, request.path_params["name"]))


async def log_in(request: Request) -> JSONResponse:
    """Add a device for a human who gives their password and commit it; the person afterwards.

    Served without a token.
    """
    body = await parse(request, LoginRequest)
    return ok(await _refusable(login, get_office(request).git, body))


async def password(request: Request) -> JSONResponse:
    """Set a human's password, committing only its hash; the person afterwards."""
    body = await parse(request, SetPasswordRequest)
    return ok(await _change(request, set_password, body.password))


ROUTES = [
    Route("/health", health, methods=["GET"]),
    Route("/whoami", whoami, methods=["GET"]),
    Route("/people/{handle}/devices", add, methods=["POST"]),
    Route("/people/{handle}/devices/{name}", remove, methods=["DELETE"]),
    Route("/login", log_in, methods=["POST"]),
    Route("/people/{handle}/password", password, methods=["PUT"]),
]

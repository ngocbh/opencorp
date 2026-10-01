"""Identity routes: the office's liveness probe, who a request acts as, and humans' devices."""

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from agent_corp.auth.devices import DeviceRefused, add_device, remove_device
from agent_corp.daemon.auth import acting_device, acting_person
from agent_corp.daemon.http import HTTPError, call, get_office, ok, parse
from agent_corp.protocol.models import AddDeviceRequest, Device, Person


async def health(request: Request) -> JSONResponse:
    """``{"ok": true}``: the office is answering. Served without a token."""
    return JSONResponse({"ok": True})


async def whoami(request: Request) -> JSONResponse:
    """``{"person": handle, "device": name | null}``: who this request acts as, and from which device."""
    return JSONResponse({"person": acting_person(request), "device": acting_device(request)})


async def _change(request: Request, change, arg) -> Person:
    try:
        return await call(change, get_office(request).git, request.path_params["handle"], arg,
                          acting_person(request))
    except DeviceRefused as exc:
        raise HTTPError(exc.status, exc.code, exc.message) from exc


async def add(request: Request) -> JSONResponse:
    """Add a device to a human's ``person.yaml`` and commit it; the person afterwards."""
    body = await parse(request, AddDeviceRequest)
    return ok(await _change(request, add_device, Device(**body.model_dump())))


async def remove(request: Request) -> JSONResponse:
    """Remove a device, by name, from a human's ``person.yaml`` and commit it; the person afterwards."""
    return ok(await _change(request, remove_device, request.path_params["name"]))


ROUTES = [
    Route("/health", health, methods=["GET"]),
    Route("/whoami", whoami, methods=["GET"]),
    Route("/people/{handle}/devices", add, methods=["POST"]),
    Route("/people/{handle}/devices/{name}", remove, methods=["DELETE"]),
]

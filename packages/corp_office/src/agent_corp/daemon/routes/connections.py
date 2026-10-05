"""Connection routes: the office's model connections, the models each offers, the default, and subscription sign-ins.

Anyone signed in sees them; only those ``may_manage_connections`` allows add, remove, sign in or change the default,
and only the person who started a sign-in sees or cancels it. No response, log line or event holds a key or token.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from agent_composer._settings import PROVIDER_DEFAULT_MODELS
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from agent_corp.auth.identity import identity_path, read_identity
from agent_corp.chat import check, models
from agent_corp.chat.connections import (OFFICE, BadConnectionName, ConnectionFile, ConnectionGone, Connections,
                                         azure_base_url, provider_label)
from agent_corp.chat.logins import LoginNotFound, Logins, LoginsClosed
from agent_corp.chat.models import ModelCache
from agent_corp.chat.provider import ProviderError
from agent_corp.company.loader import load_repo
from agent_corp.daemon.auth import acting_person
from agent_corp.daemon.http import HTTPError, call, get_office, ok, parse
from agent_corp.perm.office import may_manage_connections
from agent_corp.protocol.models import (Ack, AddConnectionRequest, ConnectionList, SetDefaultConnectionRequest,
                                       StartLoginRequest)

if TYPE_CHECKING:
    from agent_corp.daemon.app import Office


def _extra(request: Request, key: str) -> Any:
    found = get_office(request).extras.get(key)
    if found is None:
        raise HTTPError(501, "not_implemented", f"{request.method} {request.url.path} is not implemented yet")
    return found


def connections(request: Request) -> Connections:
    """The office's connections; ``501`` if this office keeps none."""
    return _extra(request, "connections")


def model_cache(request: Request) -> ModelCache:
    """The office's cache of each connection's models; ``501`` if this office keeps none."""
    return _extra(request, "models")


def logins(request: Request) -> Logins:
    """The office's subscription sign-ins; ``501`` if this office keeps none."""
    return _extra(request, "logins")


def _may_manage(office: Office, person: str) -> bool:
    owner = read_identity(identity_path(office.paths.home))
    # At HEAD: an uncommitted edit grants nothing until it is committed.
    repo = load_repo(office.git.pin(office.git.head()))
    return may_manage_connections(repo, person, owner=owner and owner.handle)


def _check_manage(office: Office, person: str) -> None:
    if not _may_manage(office, person):
        raise HTTPError(403, "forbidden", "managing this office's connections needs its owner or a grant")


def _guarded[T](fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """``fn(*args, **kwargs)``, with no such connection as a ``404`` and one that can't be used as a ``409``."""
    try:
        return fn(*args, **kwargs)
    except (ConnectionGone, BadConnectionName) as exc:
        raise HTTPError(404, "not_found", str(exc)) from None
    except ProviderError as exc:
        raise HTTPError(409, "connection_unusable", str(exc)) from None


def _starters[T](fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """``fn(*args, **kwargs)``, with no such sign-in, or another person's, as a ``404``."""
    try:
        return fn(*args, **kwargs)
    except LoginNotFound as exc:
        raise HTTPError(404, "not_found", str(exc)) from None


def _connection_list(conns: Connections, can_manage: bool) -> ConnectionList:
    # The default may be a connection whose file can't be read, and so missing from the list; it is still the default.
    found, default = _guarded(conns.infos)
    return ConnectionList(connections=found, default=default, can_manage=can_manage)


def _llm_config(body: AddConnectionRequest) -> dict:
    """The ``llm_config`` of the connection ``body`` asks for, as ``ac onboard`` builds one."""
    endpoint = (body.endpoint or "").strip()
    if body.provider == "azure":
        if not endpoint:
            raise HTTPError(422, "invalid_connection", "an Azure connection needs its endpoint or resource name")
        # Composer's azure client reads its endpoint from variables the office doesn't have; a resource's v1
        # endpoint takes the openai client with the key and the deployment as the model.
        llm = {"provider": "openai", "base_url": azure_base_url(endpoint), "api_key": body.api_key}
    elif endpoint:
        if body.provider != "openai":
            raise HTTPError(422, "invalid_connection", "only provider azure or openai takes an endpoint")
        if not body.model:
            raise HTTPError(422, "invalid_connection", "an OpenAI-compatible endpoint needs a model")
        llm = {"provider": "openai", "base_url": endpoint, "api_key": body.api_key}
    else:
        llm = {"provider": body.provider, "api_key": body.api_key}
    return llm | ({"model": body.model} if body.model else {})


def _build_and_check(conns: Connections, cache: ModelCache, body: AddConnectionRequest) -> str:
    """Add the connection ``body`` asks for once its key works, and return its name; nothing is saved otherwise."""
    # Imported here: onboarding imports the daemon, whose app imports this module.
    from agent_corp.install.onboard import OnboardError, check_provider

    llm = _llm_config(body)
    try:
        provider = check_provider({"llm_config": llm})
    except OnboardError as exc:  # its message never holds a value
        raise HTTPError(422, "invalid_connection", str(exc)) from None
    label = provider_label(llm)
    # Listed without the model asked for, which a listing would offer as the connection's own.
    listed = models.list_models(ConnectionFile(llm_config={k: v for k, v in llm.items() if k != "model"}), label)
    # Some gateways refuse their model list yet serve chat, so at an endpoint of the owner's own one reply decides.
    if listed.refused and label != "custom":
        raise HTTPError(422, "key_refused", f"The key didn't work ({listed.error})")
    if listed.error and label == "azure" and not body.model:
        # The one-reply check would ask for composer's OpenAI default, which isn't a deployment, and so report a
        # problem that isn't the real one.
        raise HTTPError(422, "models_unlisted",
                        f"Couldn't list the deployments ({listed.error}); name a model to check it with one reply")
    needs_check = True
    if listed.listed:
        ids = [m.id for m in listed.models]
        # An Azure deployment is named by its owner, so composer's OpenAI default is none of them.
        default = None if label == "azure" else PROVIDER_DEFAULT_MODELS.get(llm["provider"])
        model = body.model or default or (ids[0] if ids else None)
        if model is None:
            raise HTTPError(422, "invalid_connection", f"{label} lists no model to use; give one")
        llm["model"] = model
        # A host may not list a model it serves, such as an alias of a dated id, so one reply decides.
        needs_check = model not in ids
        provider = provider.model_copy(update={"llm_config": llm})
    if needs_check and (problem := check.one_reply_problem(provider)):
        if body.model:
            raise HTTPError(422, "model_refused", f"The model didn't answer: {problem}")
        tried = llm.get("model") or PROVIDER_DEFAULT_MODELS[llm["provider"]]
        raise HTTPError(422, "model_refused", f"The model '{tried}' didn't answer: {problem}; name another model")
    try:
        name = conns.add(label, ConnectionFile(llm_config=llm))
    except ProviderError as exc:
        raise HTTPError(409, "connection_unusable", str(exc)) from None
    cache.warm()
    return name


def _remove(conns: Connections, cache: ModelCache, name: str) -> None:
    _guarded(conns.remove, name)
    cache.invalidate(name)
    cache.warm()


def _set_default(conns: Connections, name: str) -> ConnectionList:
    _guarded(conns.set_default, name)
    return _connection_list(conns, True)


async def list_connections(request: Request) -> JSONResponse:
    """Every connection, without keys, and whether the asking person may manage them."""
    can_manage = await call(_may_manage, get_office(request), acting_person(request))
    return ok(await call(_connection_list, connections(request), can_manage))


async def add(request: Request) -> JSONResponse:
    """Add an API-key connection whose key works; the connection, without its key."""
    conns, cache = connections(request), model_cache(request)
    await call(_check_manage, get_office(request), acting_person(request))  # before the body is read
    body = await parse(request, AddConnectionRequest)
    name = await call(_build_and_check, conns, cache, body)
    return ok(await call(_guarded, conns.info, name))


async def remove(request: Request) -> JSONResponse:
    """Remove a connection and its sign-in; ``office`` can't be removed."""
    conns, cache = connections(request), model_cache(request)
    await call(_check_manage, get_office(request), acting_person(request))
    name = request.path_params["name"]
    if name == OFFICE:
        raise HTTPError(422, "set_up_by_onboard", "office is office/provider.json; `ac onboard` changes it")
    await call(_remove, conns, cache, name)
    return ok(Ack(ok=True))


async def set_default(request: Request) -> JSONResponse:
    """Make a connection the one new chats start on; every connection afterwards."""
    conns = connections(request)
    await call(_check_manage, get_office(request), acting_person(request))  # before the body is read
    body = await parse(request, SetDefaultConnectionRequest)
    return ok(await call(_set_default, conns, body.connection))


async def list_models(request: Request) -> JSONResponse:
    """The models a connection offers, kept five minutes; ``?refresh=1`` lists them again."""
    refresh = request.query_params.get("refresh") == "1"
    found = await call(_guarded, model_cache(request).get, request.path_params["name"], refresh=refresh)
    return ok(found)


async def start_login(request: Request) -> JSONResponse:
    """Start a subscription sign-in that adds a connection once approved; its URL and code to approve it with."""
    found, person = logins(request), acting_person(request)
    await call(_check_manage, get_office(request), person)  # before the body is read
    await parse(request, StartLoginRequest)
    try:
        return ok(await call(found.start, by=person))
    except LoginsClosed as exc:
        raise HTTPError(503, "stopping", str(exc)) from None


async def get_login(request: Request) -> JSONResponse:
    """A sign-in the asking person started, as it is now."""
    found = logins(request)
    return ok(await call(_starters, found.get, request.path_params["id"], by=acting_person(request)))


async def cancel_login(request: Request) -> JSONResponse:
    """Cancel a sign-in the asking person started, saving nothing."""
    found = logins(request)
    await call(_starters, found.cancel, request.path_params["id"], by=acting_person(request))
    return ok(Ack(ok=True))


ROUTES = [
    Route("/connections", list_connections, methods=["GET"]),
    Route("/connections", add, methods=["POST"]),
    Route("/connections/default", set_default, methods=["PUT"]),
    Route("/connections/login", start_login, methods=["POST"]),
    Route("/connections/login/{id}", get_login, methods=["GET"]),
    Route("/connections/login/{id}", cancel_login, methods=["DELETE"]),
    Route("/connections/{name}", remove, methods=["DELETE"]),
    Route("/connections/{name}/models", list_models, methods=["GET"]),
]

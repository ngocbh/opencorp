"""Helpers shared by the route modules: bodies, errors, and store calls off the loop."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, ValidationError
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Match

from opencorp.protocol.models import ApiError
from opencorp.store import NotFound

if TYPE_CHECKING:
    from opencorp.daemon.app import Office


class HTTPError(Exception):
    """An error response: raised in a route, rendered as an ``ApiError`` body."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def error(status: int, code: str, message: str, headers: dict[str, str] | None = None) -> JSONResponse:
    """An ``ApiError`` response."""
    return JSONResponse(ApiError(error=code, message=message).model_dump(mode="json"), status_code=status,
                        headers=headers)


def ok(body: BaseModel | list[BaseModel], status: int = 200) -> JSONResponse:
    """A JSON response of one model or a list of models."""
    content = [b.model_dump(mode="json") for b in body] if isinstance(body, list) else body.model_dump(mode="json")
    return JSONResponse(content, status_code=status)


MAX_BODY = 1 << 20
"""The largest request body the office reads, in bytes."""


def _too_large() -> HTTPError:
    return HTTPError(413, "body_too_large", f"request body is over {MAX_BODY} bytes")


async def read_body(request: Request) -> bytes:
    """The request body; ``HTTPError(413)`` once it passes ``MAX_BODY``, reading no further."""
    length = request.headers.get("content-length", "")
    if length.isdecimal() and int(length) > MAX_BODY:
        raise _too_large()
    body = bytearray()
    async for chunk in request.stream():  # a chunked body has no content-length to check
        body += chunk
        if len(body) > MAX_BODY:
            raise _too_large()
    return bytes(body)


_QUOTES_INPUT = {"union_tag_invalid": "isn't an allowed value", "literal_error": "isn't an allowed value",
                 "uuid_parsing": "should be a valid UUID", "value_error": "isn't valid", "assertion_error": "isn't valid"}
"""Fixed text for the error types whose message can quote the input."""


def _errors(model: type[BaseModel], exc: ValidationError) -> str:
    """The validation errors, naming only ``model``'s top-level fields: never an input value or an extra key."""
    lines = []
    for e in exc.errors(include_url=False, include_input=False, include_context=False):
        head = e["loc"][0] if e["loc"] else None
        where = head if head in model.model_fields else "body" if head is None else "an extra field"
        lines.append(f"{where}: {_QUOTES_INPUT.get(e['type'], e['msg'])}")
    return "; ".join(lines)


async def parse[M: BaseModel](request: Request, model: type[M]) -> M:
    """The request body validated as ``model``; ``HTTPError(422)`` when it isn't."""
    body = await read_body(request)
    # Parsed on the loop: at MAX_BODY this takes a few milliseconds.
    # The 422 never echoes the body: it may hold a key or a password.
    try:
        data = json.loads(body)
    except (ValueError, RecursionError):  # JSONDecodeError is a ValueError
        raise HTTPError(422, "invalid_body", "the body isn't JSON") from None
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        raise HTTPError(422, "invalid_body", _errors(model, exc)) from None


async def call[T](fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """Run a blocking store or git call in a thread."""
    return await asyncio.to_thread(fn, *args, **kwargs)


def get_office(request: Request) -> Office:
    """The office this app serves."""
    return request.app.state.office


async def not_implemented(request: Request) -> JSONResponse:
    """A ``501`` for a route whose behaviour hasn't landed yet."""
    return error(501, "not_implemented", f"{request.method} {request.url.path} is not implemented yet")


async def _http_error(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, HTTPError)
    return error(exc.status, exc.code, exc.message)


async def _starlette_error(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, HTTPException)
    if exc.status_code == 404:
        return error(404, "no_route", f"no route {request.method} {request.url.path}")
    if exc.status_code == 405:
        return error(405, "method_not_allowed", f"{request.method} is not allowed on {request.url.path}",
                     {"allow": _allowed_methods(request)})
    return error(exc.status_code, "http_error", str(exc.detail), exc.headers)


def _allowed_methods(request: Request) -> str:
    # Starlette's Allow names only the first route that matched the path; a path can have
    # one route per method.
    methods: set[str] = set()
    for route in request.app.router.routes:
        match, _ = route.matches(request.scope)
        if match is not Match.NONE:
            methods |= getattr(route, "methods", None) or set()
    return ", ".join(sorted(methods))


async def _not_found(request: Request, exc: Exception) -> JSONResponse:
    return error(404, "not_found", str(exc))


async def _internal_error(request: Request, exc: Exception) -> JSONResponse:
    # Starlette still re-raises the exception after this response, so uvicorn logs it and
    # closes the connection; "connection: close" tells the client not to reuse it.
    response = error(500, "internal_error", "internal error")
    response.headers["connection"] = "close"
    return response


EXCEPTION_HANDLERS = {HTTPError: _http_error, HTTPException: _starlette_error, NotFound: _not_found,
                      Exception: _internal_error}

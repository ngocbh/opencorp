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

from agent_corp.protocol.models import ApiError
from agent_corp.store import NotFound

if TYPE_CHECKING:
    from agent_corp.daemon.app import Office


class HTTPError(Exception):
    """An error response: raised in a route, rendered as an ``ApiError`` body."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def error(status: int, code: str, message: str) -> JSONResponse:
    """An ``ApiError`` response."""
    return JSONResponse(ApiError(error=code, message=message).model_dump(mode="json"), status_code=status)


def ok(body: BaseModel | list[BaseModel], status: int = 200) -> JSONResponse:
    """A JSON response of one model or a list of models."""
    content = [b.model_dump(mode="json") for b in body] if isinstance(body, list) else body.model_dump(mode="json")
    return JSONResponse(content, status_code=status)


async def parse[M: BaseModel](request: Request, model: type[M]) -> M:
    """The request body validated as ``model``; ``HTTPError(422)`` when it isn't."""
    try:
        return model.model_validate(json.loads(await request.body()))
    except (ValueError, ValidationError) as exc:  # JSONDecodeError is a ValueError
        raise HTTPError(422, "invalid_body", str(exc)) from exc


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
        return error(405, "method_not_allowed", f"{request.method} is not allowed on {request.url.path}")
    return error(exc.status_code, "http_error", str(exc.detail))


async def _not_found(request: Request, exc: Exception) -> JSONResponse:
    return error(404, "not_found", str(exc))


async def _internal_error(request: Request, exc: Exception) -> JSONResponse:
    # Starlette still re-raises the exception after this response, so uvicorn logs it.
    return error(500, "internal_error", "internal error")


EXCEPTION_HANDLERS = {HTTPError: _http_error, HTTPException: _starlette_error, NotFound: _not_found,
                      Exception: _internal_error}

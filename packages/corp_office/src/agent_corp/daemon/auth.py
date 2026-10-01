"""Who sent each request: the middleware that checks device tokens, and ``acting_person`` for routes."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from starlette.requests import Request

from agent_corp.auth.roster import Roster, load_roster
from agent_corp.auth.tokens import AuthError, authenticate
from agent_corp.daemon.http import HTTPError, error

if TYPE_CHECKING:
    from agent_corp.daemon.app import Office

OPEN = frozenset({("GET", "/health"), ("HEAD", "/health")})
"""Requests served without a token even once tokens are enforced: the "is the office up" probe of
``ac``, ``ac start``, ``ac doctor`` and onboarding."""


def acting_person(request: Request) -> str:
    """The handle the request acts as: its token's person, or the CEO while no human has a device."""
    person = getattr(request.state, "person", None)
    if person is None:
        raise HTTPError(401, "unauthenticated", "this request has no person to act as")
    return person


def acting_device(request: Request) -> str | None:
    """The device whose token the request carried; None for a request without one."""
    return getattr(request.state, "device", None)


class DeviceTokens:
    """Pure ASGI middleware: ties each request to a person by its ``Authorization: Bearer`` token.

    While no human in the company (at HEAD) lists a device, a request without a token acts as
    the CEO; after that every request but those in ``OPEN`` needs one. A token sent is always
    checked. The person and device go in ``scope["state"]``.
    """

    def __init__(self, app: Any, office: Office) -> None:
        self.app = app
        self.office = office
        self._roster: Roster | None = None

    async def roster(self) -> Roster:
        """The roster at HEAD, reloaded only when HEAD moves."""
        git = self.office.git
        try:
            head = git.read_head()  # on the loop: two small file reads cost less than a thread hop
        except ValueError:  # no commit yet
            return Roster("", None)
        if self._roster is None or self._roster.head != head:
            self._roster = await asyncio.to_thread(load_roster, git, head)
        return self._roster

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] != "http" or (scope["method"], scope["path"]) in OPEN:
            return await self.app(scope, receive, send)
        header = next((v.decode("latin-1") for k, v in scope["headers"] if k.lower() == b"authorization"), None)
        roster = await self.roster()
        try:
            person, device = authenticate(header, roster)
        except AuthError as exc:
            if exc.code != "unauthenticated" or roster.enforced:
                return await error(401, exc.code, exc.message)(scope, receive, send)
            person, device = roster.ceo, None
        state = scope.setdefault("state", {})
        state["person"], state["device"] = person, device
        await self.app(scope, receive, send)

"""The event stream: stored metadata events and live transcript events, as SSE."""

from collections.abc import AsyncIterator

from starlette.requests import Request
from starlette.responses import Response, StreamingResponse
from starlette.routing import Route

from opencorp.daemon.bus import PING
from opencorp.daemon.http import error, get_office
from opencorp.protocol.models import Event, LiveEvent

PING_S = 15.0
"""Seconds of silence before a ``: ping`` comment keeps the stream open."""

# The empty data field makes standard SSE parsers (EventSource included) dispatch the event;
# one with no data field at all is silently skipped.
RESET = b"event: reset\ndata:\n\n"


def frame(kind: str, event: Event | LiveEvent) -> bytes:
    """One SSE frame; ``meta`` frames carry the event id."""
    head = f"event: {kind}\n" + (f"id: {event.id}\n" if isinstance(event, Event) else "")
    return f"{head}data: {event.model_dump_json()}\n\n".encode()


async def stream_events(request: Request) -> Response:
    """Stream bus events, optionally for one session.

    There is no replay, so a client bootstraps in this order: open ``/events``, wait for
    ``: connected``, GET the state it needs, then apply the events buffered since
    ``: connected``, in order. A buffered event the snapshot already reflects is harmless to
    apply: applying them all in order ends at the latest state.

    ``part.delta`` only appends text. A client that joined mid-stream ignores deltas for a
    part until it has that part from a ``part.updated`` or ``message.updated`` received after
    its snapshot.

    ``event: reset`` means the office dropped this client for falling behind; the stream then
    ends, and the client reconnects and bootstraps again. Any other end of the stream (the
    office stopping) also calls for a fresh bootstrap.
    """
    if request.method != "GET":
        # Starlette serves HEAD on every GET route; a HEAD response to a stream that never
        # ends would hold the connection forever.
        return error(405, "method_not_allowed", f"{request.method} is not allowed on /events", {"allow": "GET"})
    bus = get_office(request).bus
    session = request.query_params.get("session")

    async def body() -> AsyncIterator[bytes]:
        # Subscribed before ": connected" is sent, so a client gets every event published
        # after it sees that line. Subscribing here, not in the handler, means a response
        # that never starts leaves no subscription behind.
        sub = bus.subscribe(session)
        try:
            yield b": connected\n\n"
            while True:
                item = await sub.next(timeout=PING_S)
                if item is None:
                    if sub.dropped:
                        yield RESET
                    return
                if item is PING:
                    yield b": ping\n\n"
                else:
                    yield frame(*item)
        finally:
            sub.close()

    return StreamingResponse(body(), media_type="text/event-stream", headers={"cache-control": "no-cache"})


ROUTES = [Route("/events", stream_events, methods=["GET"])]

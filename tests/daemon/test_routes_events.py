"""GET /events over a real socket (httpx's ASGITransport buffers whole responses)."""

import asyncio
import json

import pytest

from agent_corp.daemon.routes import events
from agent_corp.protocol.models import LiveEvent
from agent_corp.store import new_id
from tests.daemon.conftest import served
from tests.store.conftest import message, session


async def frames(response):
    """Yield (event, id, data) per SSE frame, and ("comment", None, text) per comment line."""
    event, eid, data = None, None, None
    async for line in response.aiter_lines():
        if line.startswith(":"):
            yield "comment", None, line[1:].strip()
        elif line.startswith("event: "):
            event = line[7:]
        elif line.startswith("id: "):
            eid = line[4:]
        elif line.startswith("data: "):
            data = json.loads(line[6:])
        elif line == "" and event is not None:
            yield event, eid, data
            event, eid, data = None, None, None


async def take(it, n):
    async with asyncio.timeout(5):
        return [await anext(it) for _ in range(n)]


async def test_session_events_arrive_in_order_after_connected(office, short_dir):
    async with served(office, short_dir / "o.sock") as c, c.stream("GET", "/events") as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        it = frames(r)
        assert await take(it, 1) == [("comment", None, "connected")]
        s = office.store.create_session(session())
        office.store.update_session(s.id, status="busy")
        office.store.update_session(s.id, status="idle")
        got = await take(it, 3)
        stored = office.store.events_after()
        assert [(e, i) for e, i, _ in got] == [("meta", ev.id) for ev in stored]
        assert [d["type"] for _, _, d in got] == ["session.created", "session.updated", "session.updated"]
        assert got[-1][2]["data"]["status"] == "idle"


async def test_session_filter(office, short_dir):
    a = office.store.create_session(session())
    b = office.store.create_session(session())
    async with served(office, short_dir / "o.sock") as c, c.stream("GET", "/events", params={"session": a.id}) as r:
        it = frames(r)
        await take(it, 1)
        office.store.update_session(b.id, status="busy")
        office.store.update_session(a.id, status="busy")
        [(_, _, data)] = await take(it, 1)
        assert data["subject_id"] == a.id


async def test_live_events_are_framed_as_live(office, short_dir):
    s = office.store.create_session(session())
    live = LiveEvent(type="part.delta", session_id=s.id, data={"message_id": "m", "part_id": "p", "text": "he"})
    async with served(office, short_dir / "o.sock") as c, c.stream("GET", "/events") as r:
        it = frames(r)
        await take(it, 1)
        office.bus.publish_live(live)
        assert await take(it, 1) == [("live", None, live.model_dump(mode="json"))]


async def test_idle_stream_gets_pings(office, short_dir, monkeypatch):
    monkeypatch.setattr(events, "PING_S", 0.05)
    async with served(office, short_dir / "o.sock") as c, c.stream("GET", "/events") as r:
        it = frames(r)
        assert await take(it, 2) == [("comment", None, "connected"), ("comment", None, "ping")]


async def test_late_subscriber_gets_history_from_messages_not_replay(office, short_dir):
    s = office.store.create_session(session())
    m = office.store.add_message(message(s.id, parts=[{"id": new_id(), "type": "text", "text": "done"}]))
    async with served(office, short_dir / "o.sock") as c:
        office.bus.publish_live(LiveEvent(type="message.updated", session_id=s.id, data=m.model_dump(mode="json")))
        await asyncio.sleep(0.1)
        async with c.stream("GET", "/events", params={"session": s.id}) as r:
            it = frames(r)
            await take(it, 1)
            office.store.update_session(s.id, status="idle")
            [(kind, _, data)] = await take(it, 1)
            assert kind == "meta" and data["type"] == "session.updated"  # the earlier live event is not replayed
        assert (await c.get(f"/sessions/{s.id}/messages")).json() == [m.model_dump(mode="json")]


async def test_shutdown_ends_open_streams(office, short_dir):
    async with asyncio.timeout(5):
        async with served(office, short_dir / "o.sock") as c:
            async with c.stream("GET", "/events") as r:
                it = frames(r)  # one iterator: httpx refuses a second pass over a stream
                await take(it, 1)
                office.bus.close()
                with pytest.raises(StopAsyncIteration):
                    await anext(it)


async def test_client_disconnect_drops_its_subscription(office, short_dir):
    async with served(office, short_dir / "o.sock") as c:
        async with c.stream("GET", "/events") as r:
            await take(frames(r), 1)
            assert office.bus.subscriber_count == 1
        async with asyncio.timeout(5):
            while office.bus.subscriber_count:
                await asyncio.sleep(0.02)


async def test_a_dropped_subscriber_gets_reset_then_the_stream_ends(office, short_dir):
    s = office.store.create_session(session())
    office.bus.queue_size = 3
    async with served(office, short_dir / "o.sock") as c, c.stream("GET", "/events") as r:
        it = frames(r)
        await take(it, 1)
        # Published in one go on the loop, so the backlog overflows before the stream reads it.
        for i in range(10):
            office.bus.publish_live(LiveEvent(type="part.delta", session_id=s.id,
                                              data={"message_id": "m", "part_id": "p", "text": str(i)}))
        assert await take(it, 1) == [("reset", None, None)]
        with pytest.raises(StopAsyncIteration):
            await anext(it)

"""HQ's /api/events: the /events contract, HQ's event types only, and the session checked on every frame."""

import asyncio
from typing import get_args

import pytest

from opencorp.auth.passwords import hash_password
from opencorp.hq import api
from opencorp.hq import sessions as sessions_module
from opencorp.hq.sessions import TTL
from opencorp.protocol import now
from opencorp.protocol.models import Event, LiveEvent
from opencorp.store import new_id
from tests.daemon.test_routes_events import frames, take
from tests.hq.conftest import hq_served
from tests.hq.test_sessions import T0, Clock, hand_edit


def meta(type_: str, subject: str = "S", **data) -> Event:
    return Event(id=new_id(), type=type_, at=now(), subject_id=subject, data=data)


def part_delta() -> LiveEvent:
    return LiveEvent(type="part.delta", session_id=new_id(), data={"message_id": "m", "part_id": "p", "text": "x"})


async def ends(it):
    """Read frames until the stream ends."""
    async with asyncio.timeout(3):
        async for _ in it:
            pass


async def test_only_hq_event_types_arrive(office, hq, short_dir):
    async with hq_served(office, hq, short_dir / "hq.sock") as c, c.stream("GET", "/api/events") as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        it = frames(r)
        assert await take(it, 1) == [("comment", None, "connected")]
        office.bus.publish_live(part_delta())
        office.bus.publish_live(LiveEvent(type="message.updated", session_id=new_id(), data={}))
        others = set(get_args(Event.model_fields["type"].annotation)) - api.HQ_EVENT_TYPES
        assert {"profile.updated", "feedback.created", "debrief.updated", "profile_proposal.created",
                "comment.created"} <= others
        for t in sorted(others):
            office.bus.publish_meta(meta(t))
        head = office.git.head()
        types = ["session.created", "session.updated", "question.created", "question.updated",
                 "work_item.created", "work_item.updated"]
        sent = [meta(t) for t in types] + [meta("company.updated", head, sha=head)]
        for event in sent:
            office.bus.publish_meta(event)
        got = await take(it, len(sent))
        assert [(kind, eid, data["type"]) for kind, eid, data in got] == [("meta", e.id, e.type) for e in sent]


async def test_idle_stream_gets_pings(office, hq, short_dir, monkeypatch):
    monkeypatch.setattr(api, "PING_S", 0.05)
    async with hq_served(office, hq, short_dir / "hq.sock") as c, c.stream("GET", "/api/events") as r:
        assert await take(frames(r), 2) == [("comment", None, "connected"), ("comment", None, "ping")]


async def test_a_dropped_stream_gets_reset_then_ends(office, hq, short_dir):
    office.bus.queue_size = 3
    async with hq_served(office, hq, short_dir / "hq.sock") as c, c.stream("GET", "/api/events") as r:
        it = frames(r)
        await take(it, 1)
        for _ in range(10):  # in one go on the loop, so the backlog overflows before the stream reads it
            office.bus.publish_meta(meta("session.updated"))
        assert await take(it, 1) == [("reset", None, None)]
        with pytest.raises(StopAsyncIteration):
            await anext(it)


async def test_events_need_a_session_and_refuse_head(office, hq, short_dir):
    async with hq_served(office, hq, short_dir / "hq.sock") as c:
        r = await c.head("/api/events")
        assert r.status_code == 405 and r.headers["allow"] == "GET"
        c.cookies.clear()
        r = await c.get("/api/events")
        assert (r.status_code, r.json()["error"]) == (401, "sign_in_required")
        assert office.bus.subscriber_count == 0


async def test_a_closed_stream_is_unregistered(office, hq, short_dir):
    async with hq_served(office, hq, short_dir / "hq.sock") as c:
        sid = office.store.list_hq_sessions()[0].id
        async with c.stream("GET", "/api/events") as r:
            await take(frames(r), 1)
            assert len(hq.sessions._live[sid].streams) == 1
        async with asyncio.timeout(5):
            while office.bus.subscriber_count or hq.sessions._live[sid].streams:
                await asyncio.sleep(0.02)


async def busy(office):
    """Publish an HQ event every 10 ms, so the stream always has a frame to send."""
    while True:
        office.bus.publish_meta(meta("session.updated", id="S"))
        await asyncio.sleep(0.01)


async def test_revoking_ends_a_busy_stream(office, hq, short_dir):
    async with hq_served(office, hq, short_dir / "hq.sock") as c, c.stream("GET", "/api/events") as r:
        sid = office.store.list_hq_sessions()[0].id
        it = frames(r)
        assert await take(it, 1) == [("comment", None, "connected")]
        noise = asyncio.create_task(busy(office))
        try:
            await take(it, 3)
            await hq.sessions.revoke(sid)
            await ends(it)
        finally:
            noise.cancel()


async def test_expiry_ends_a_busy_stream(office, hq, short_dir):
    async with hq_served(office, hq, short_dir / "hq.sock") as c, c.stream("GET", "/api/events") as r:
        it = frames(r)
        assert await take(it, 1) == [("comment", None, "connected")]
        noise = asyncio.create_task(busy(office))
        try:
            await take(it, 3)
            late = Clock()
            late.now = T0 + 2 * TTL  # past any session issued now
            hq.sessions.clock = late
            await ends(it)
        finally:
            noise.cancel()


async def test_expiry_ends_an_idle_stream_at_its_next_ping(office, hq, short_dir, monkeypatch):
    monkeypatch.setattr(api, "PING_S", 0.05)
    async with hq_served(office, hq, short_dir / "hq.sock") as c, c.stream("GET", "/api/events") as r:
        it = frames(r)
        await take(it, 1)
        late = Clock()
        late.now = T0 + 2 * TTL
        hq.sessions.clock = late
        with pytest.raises(StopAsyncIteration):
            async with asyncio.timeout(3):
                while True:
                    await anext(it)


async def test_a_password_change_ends_the_stream_at_company_updated(office, hq, short_dir, company):
    async with hq_served(office, hq, short_dir / "hq.sock") as c, c.stream("GET", "/api/events") as r:
        it = frames(r)
        await take(it, 1)
        hand_edit(company, "ngocbh", password_hash=hash_password("brand new one"))
        sha = office.git.head()
        await asyncio.to_thread(office.store.emit, "company.updated", sha, {"sha": sha})
        with pytest.raises(StopAsyncIteration):  # no company.updated frame first
            await take(it, 1)
        assert (await c.get("/api/whoami")).status_code == 401


async def test_a_failing_recheck_ends_the_stream_quietly_and_keeps_the_session(office, hq, short_dir, company,
                                                                               monkeypatch, caplog):
    async with hq_served(office, hq, short_dir / "hq.sock") as c, c.stream("GET", "/api/events") as r:
        sid = office.store.list_hq_sessions()[0].id
        it = frames(r)
        await take(it, 1)

        def broken(git, sha):
            raise OSError("git went away")

        monkeypatch.setattr(sessions_module, "password_fps", broken)
        hand_edit(company, "ngocbh", title="Boss")  # a commit whose fingerprints aren't loaded yet
        sha = office.git.head()
        await asyncio.to_thread(office.store.emit, "company.updated", sha, {"sha": sha})
        await ends(it)
        assert office.store.get_hq_session(sid) is not None
    assert f"couldn't re-check HQ session {sid} at {sha}; ending its stream" in caplog.text
    assert "Exception in ASGI application" not in caplog.text


async def test_an_unreadable_person_file_ends_the_stream_but_not_the_session(office, hq, short_dir, company):
    async with hq_served(office, hq, short_dir / "hq.sock") as c:
        sid = office.store.list_hq_sessions()[0].id
        async with c.stream("GET", "/api/events") as r:
            it = frames(r)
            await take(it, 1)
            hand_edit(company, "ngocbh", kind="robot")
            sha = office.git.head()
            await asyncio.to_thread(office.store.emit, "company.updated", sha, {"sha": sha})
            with pytest.raises(StopAsyncIteration):  # no company.updated frame first
                await take(it, 1)
        assert office.store.get_hq_session(sid) is not None
        assert (await c.get("/api/whoami")).status_code == 401
        hand_edit(company, "ngocbh", kind="human")
        assert (await c.get("/api/whoami")).status_code == 200

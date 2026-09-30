"""The bus fans meta and live events out to subscribers on the office loop."""

import asyncio
import threading

from agent_corp.daemon.bus import PING, Bus
from agent_corp.protocol import now
from agent_corp.protocol.models import Event, LiveEvent
from agent_corp.store import new_id
from tests.store.conftest import session

S1, S2 = new_id(), new_id()


def meta(subject: str, type: str = "session.updated", **data) -> Event:
    return Event(id=new_id(), type=type, at=now(), subject_id=subject, data=data)


def live(session_id: str, text: str = "x") -> LiveEvent:
    return LiveEvent(type="part.delta", session_id=session_id,
                     data={"message_id": "m", "part_id": "p", "text": text})


def attached(**kw) -> Bus:
    bus = Bus(**kw)
    bus.attach(asyncio.get_running_loop())
    return bus


async def test_events_arrive_in_publish_order():
    bus = attached()
    sub = bus.subscribe()
    a, b, c = meta(S1), live(S1), meta(S2)
    bus.publish_meta(a)
    bus.publish_live(b)
    bus.publish_meta(c)
    assert [await sub.next(timeout=1) for _ in range(3)] == [("meta", a), ("live", b), ("meta", c)]


async def test_session_filter_matches_subject_data_and_live_session():
    bus = attached()
    sub = bus.subscribe(S1)
    q = meta(new_id(), type="question.created", session_id=S1)
    mine = live(S1)
    bus.publish_meta(meta(S2))
    bus.publish_meta(q)
    bus.publish_live(live(S2))
    bus.publish_live(mine)
    own = meta(S1)
    bus.publish_meta(own)
    got = [await sub.next(timeout=1) for _ in range(3)]
    assert got == [("meta", q), ("live", mine), ("meta", own)]
    assert await sub.next(timeout=0.05) is PING


async def test_publish_from_another_thread_keeps_order():
    bus = attached()
    sub = bus.subscribe()
    t = threading.Thread(target=lambda: [bus.publish_live(live(S1, str(i))) for i in range(200)])
    t.start()
    t.join()
    texts = [(await sub.next(timeout=1))[1].data["text"] for _ in range(200)]
    assert texts == [str(i) for i in range(200)]


async def test_slow_subscriber_is_dropped_and_others_keep_going():
    bus = attached(queue_size=3)
    slow, fast = bus.subscribe(), bus.subscribe()
    for i in range(5):
        bus.publish_live(live(S1, str(i)))
        assert (await fast.next(timeout=1))[1].data["text"] == str(i)
    assert slow.dropped and not fast.dropped
    assert await slow.next(timeout=1) is None  # its backlog was discarded
    assert bus.subscriber_count == 1


async def test_close_ends_every_subscription():
    bus = attached()
    sub = bus.subscribe()
    bus.close()
    assert await sub.next(timeout=1) is None and not sub.dropped
    assert await bus.subscribe().next(timeout=1) is None
    bus.publish_meta(meta(S1))  # dropped, no error


def test_publish_before_attach_is_dropped():
    Bus().publish_live(live(S1))


async def test_closed_subscription_is_removed():
    bus = attached()
    sub = bus.subscribe()
    sub.close()
    assert bus.subscriber_count == 0


async def test_store_events_are_published_after_commit(office):
    await office.start()
    sub = office.bus.subscribe()
    created = office.store.create_session(session())
    kind, event = await sub.next(timeout=1)
    assert kind == "meta" and event.type == "session.created" and event.subject_id == created.id
    assert event == office.store.events_after()[-1]
    await office.stop()

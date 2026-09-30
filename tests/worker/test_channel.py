import dataclasses
import enum
import socket
import struct
import threading
from pathlib import Path

import pytest
from pydantic import BaseModel

from agent_corp.worker import channel as channel_module
from agent_corp.worker.channel import Channel, ChannelClosed, FrameTooLarge, jsonable


@pytest.fixture
def pair():
    a, b = socket.socketpair()
    left, right = Channel(a), Channel(b)
    yield left, right
    left.close()
    right.close()


def test_frames_round_trip_in_order(pair):
    left, right = pair
    frames = [{"type": "start", "n": 1}, {"text": "héllo ✓", "nested": {"a": [1, 2.5, None, True]}}, {}]
    for frame in frames:
        left.send(frame)
    assert [right.recv() for _ in frames] == frames


def test_an_oversized_frame_is_refused_on_both_ends(pair, monkeypatch):
    left, right = pair
    monkeypatch.setattr(channel_module, "MAX_FRAME", 64)
    with pytest.raises(FrameTooLarge):
        left.send({"text": "x" * 100})
    left.sock.sendall(struct.pack(">I", 65) + b"{}")
    with pytest.raises(FrameTooLarge):
        right.recv()


def test_a_frame_must_be_an_object(pair):
    left, right = pair
    left.sock.sendall(struct.pack(">I", 2) + b"[]")
    with pytest.raises(ValueError, match="JSON object"):
        right.recv()


def test_close_send_ends_one_direction_only(pair):
    left, right = pair
    left.send({"n": 1})
    left.close_send()
    with pytest.raises(ChannelClosed):
        left.send({"n": 2})
    assert right.recv() == {"n": 1}
    with pytest.raises(ChannelClosed):
        right.recv()
    right.send({"n": 3})
    assert left.recv() == {"n": 3}


def test_peer_close_and_a_cut_frame_raise_channel_closed(pair):
    left, right = pair
    left.sock.sendall(struct.pack(">I", 10) + b'{"a"')
    left.close()
    with pytest.raises(ChannelClosed):
        right.recv()
    with pytest.raises(ChannelClosed):
        right.recv()


def test_close_wakes_a_blocked_reader(pair):
    left, right = pair
    raised = []

    def read():
        try:
            right.recv()
        except ChannelClosed:
            raised.append(True)

    reader = threading.Thread(target=read)
    reader.start()
    right.close()
    reader.join(5)
    assert raised == [True]


def test_send_after_the_peer_is_gone_raises_channel_closed():
    a, b = socket.socketpair()
    left = Channel(a)
    b.close()  # as when the worker process dies
    with pytest.raises(ChannelClosed):
        left.send({"x": "y"})
    left.close()


def test_concurrent_sends_do_not_interleave(pair):
    left, right = pair
    threads = [threading.Thread(target=lambda n=n: [left.send({"t": n, "i": i, "pad": "p" * 5000})
                                                    for i in range(50)]) for n in range(4)]
    for t in threads:
        t.start()
    got = [right.recv() for _ in range(200)]
    for t in threads:
        t.join()
    for n in range(4):
        assert [f["i"] for f in got if f["t"] == n] == list(range(50))


class Color(enum.Enum):
    RED = "red"


class Model(BaseModel):
    when: int


@dataclasses.dataclass
class Inner:
    color: Color
    where: Path


@dataclasses.dataclass
class Outer:
    inner: Inner
    items: tuple
    tags: frozenset
    model: Model
    other: object


def test_jsonable_unpacks_observer_values():
    value = Outer(Inner(Color.RED, Path("/a/b")), (1, "x"), frozenset({"t"}), Model(when=3), object)
    assert jsonable(value) == {"inner": {"color": "red", "where": "/a/b"}, "items": [1, "x"], "tags": ["t"],
                               "model": {"when": 3}, "other": repr(object)}
    assert jsonable({1: None}) == {"1": None}

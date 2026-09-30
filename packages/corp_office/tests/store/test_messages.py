"""Messages and parts: the transcript (live content, no events)."""

import pytest

from agent_corp.protocol.models import TextPart, ToolPart
from agent_corp.store import DuplicateKey, NotFound, new_id
from tests.store.conftest import message, session


@pytest.fixture
def sid(store):
    return store.create_session(session()).id


def _text(text="hi"):
    return TextPart(id=new_id(), type="text", text=text)


def _tool(state="running", **over):
    return ToolPart.model_validate(
        {"id": new_id(), "type": "tool", "call_id": "c1", "tool": "shell", "state": state, "input": {"cmd": "ls"}, **over}
    )


def test_message_round_trips_with_every_part_kind(store, sid):
    parts = [_text(), {"id": new_id(), "type": "file", "path": "a.txt", "mime": "text/plain"}, _tool()]
    m = message(sid, parts)
    assert store.add_message(m) == m == store.get_message(m.id)
    before = len(store.events_after())
    assert before == 1  # only session.created


def test_put_part_appends_and_replaces_in_place(store, sid):
    first, tool = _text("a"), _tool()
    m = store.add_message(message(sid, [first, tool]))
    done = tool.model_copy(update={"state": "completed", "output": {"stdout": "x"}})
    store.put_part(m.id, done)
    got = store.put_part(m.id, _text("b"))
    assert [p.id for p in got.parts][:2] == [first.id, tool.id]
    assert got.parts[1].state == "completed" and got.parts[2].text == "b"


def test_part_cannot_move_between_messages(store, sid):
    part = _text()
    store.add_message(message(sid, [part]))
    other = store.add_message(message(sid))
    with pytest.raises(DuplicateKey):
        store.put_part(other.id, part)
    with pytest.raises(NotFound):
        store.put_part("01K6A0000000000000000000ZZ", _text())


def test_list_messages_in_order(store, sid):
    a = store.add_message(message(sid, [_text("1")], role="user"))
    b = store.add_message(message(sid, [_text("2")]))
    store.add_message(message(store.create_session(session()).id))
    assert store.list_messages(sid) == [a, b]

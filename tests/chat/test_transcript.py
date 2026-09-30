import pytest

from agent_corp.chat.transcript import Transcript
from agent_corp.store import Store
from tests.store.conftest import session


@pytest.fixture
def setup(tmp_path):
    store = Store(tmp_path / "store.sqlite")
    s = store.create_session(session())
    live = []
    yield store, s, Transcript(store, s.id, live.append), live
    store.close()


def stream(node, chunk, final=False, exchange="x1"):
    return {"type": "stream", "node_id": node, "key": "reply", "chunk": chunk, "final": final,
            "exchange_id": exchange}


def test_a_user_message_is_stored_and_published(setup):
    store, s, t, live = setup
    message = t.user("hi")
    assert [m.parts[0].text for m in store.list_messages(s.id)] == ["hi"]
    assert live[0].type == "message.updated" and live[0].data["id"] == message.id


def test_streamed_text_is_stored_at_first_and_last_chunk_and_sent_as_deltas(setup):
    store, s, t, live = setup
    t.event("NodeStarted", {"node_id": "chat#0/reply"})
    t.event("ModelCallStarted", {"node_id": "chat#0/reply", "exchange_id": "x1", "purpose": "chat"})
    t.stream(stream("chat#0/reply", ""))
    t.stream(stream("chat#0/reply", "hello "))
    t.stream(stream("chat#0/reply", "there"))
    t.stream(stream("chat#0/reply", "", final=True))
    t.event("NodeSucceeded", {"node_id": "chat#0/reply", "output": "hello there"})
    [message] = store.list_messages(s.id)
    assert message.role == "assistant" and [p.text for p in message.parts] == ["hello there"]
    assert [e.type for e in live] == ["message.updated", "part.updated", "part.delta", "part.updated"]
    assert live[1].data["part"]["text"] == "hello " and live[2].data["text"] == "there"
    assert live[3].data["part"]["text"] == "hello there"


def test_tool_calls_become_tool_parts(setup):
    store, s, t, live = setup
    n = "chat#0/reply"
    t.event("ModelCallStarted", {"node_id": n, "exchange_id": "x1", "purpose": "chat"})
    t.event("ToolCallStarted", {"node_id": n, "exchange_id": "x1", "call_index": 0, "tool_call_id": "c1",
                                "name": "shell", "arguments": {"command": "ls"}})
    t.event("ToolCallFinished", {"node_id": n, "exchange_id": "x1", "call_index": 0, "tool_call_id": "c1",
                                 "name": "shell", "result": "a.txt"})
    t.event("ToolCallStarted", {"node_id": n, "exchange_id": "x1", "call_index": 1, "tool_call_id": "c2",
                                "name": "search", "arguments": {"pattern": "x"}})
    t.event("ToolCallFinished", {"node_id": n, "exchange_id": "x1", "call_index": 1, "tool_call_id": "c2",
                                 "name": "search", "error": "ToolException"})
    t.event("ToolCallStarted", {"node_id": n, "exchange_id": "x1", "call_index": 2, "tool_call_id": "c3",
                                "name": "shell", "arguments": {"command": "sleep 9"}})
    t.event("NodeSucceeded", {"node_id": n, "output": "done"})
    [message] = store.list_messages(s.id)
    tools = [(p.call_id, p.state, p.output, p.error) for p in message.parts if p.type == "tool"]
    assert tools == [("c1", "completed", "a.txt", None), ("c2", "error", {}, "ToolException"),
                     ("c3", "interrupted", {}, None)]
    assert [p.text for p in message.parts if p.type == "text"] == ["done"]  # nothing streamed


def test_a_node_that_never_called_a_model_writes_nothing(setup):
    store, s, t, live = setup
    t.event("NodeSucceeded", {"node_id": "chat#0/route", "output": "reply"})
    t.event("NodeFailed", {"failure": {"node_id": None, "code": "x", "message": ""}})
    assert store.list_messages(s.id) == [] and live == []


def test_each_occurrence_gets_its_own_message(setup):
    store, s, t, live = setup
    for i, text in enumerate(["one", "two"]):
        n = f"chat#{i}/reply"
        t.event("ModelCallStarted", {"node_id": n, "exchange_id": f"x{i}", "purpose": "chat"})
        t.stream(stream(n, text, exchange=f"x{i}"))
        t.event("NodeSucceeded", {"node_id": n, "output": text})
    assert [[p.text for p in m.parts] for m in store.list_messages(s.id)] == [["one"], ["two"]]

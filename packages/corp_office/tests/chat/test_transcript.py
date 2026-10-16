import pytest

from agent_corp.chat.transcript import INTERRUPTED_TEXT, Transcript
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


def test_abort_marks_an_unfinished_text_part_and_interrupts_running_tools(setup):
    store, s, t, live = setup
    t.event("ModelCallStarted", {"node_id": "chat#0/reply", "exchange_id": "x1", "purpose": "chat"})
    t.stream(stream("chat#0/reply", "half a sen"))
    t.stream(stream("chat#0/reply", "tence"))
    t.event("ToolCallStarted", {"node_id": "chat#0/reply", "tool_call_id": "c1", "name": "shell",
                                "arguments": {"command": "sleep 9"}})
    t.abort()
    (message,) = store.list_messages(s.id)
    text, tool = message.parts
    assert text.text == "half a sentence\n\n[interrupted]"
    assert tool.state == "interrupted"
    t.abort()
    assert store.list_messages(s.id) == [message]


def call(n, exchange, call_id, event="ToolCallStarted", **fields):
    return event, {"node_id": n, "exchange_id": exchange, "call_index": 0, "tool_call_id": call_id,
                   "name": "shell", "arguments": {"command": "ls"}, **fields}


def test_a_user_message_mid_reply_comes_before_what_the_model_says_after_reading_it(setup):
    store, s, t, live = setup
    n = "chat#0/reply"
    t.event("ModelCallStarted", {"node_id": n, "exchange_id": "x1", "purpose": "chat"})
    t.stream(stream(n, "Working", exchange="x1"))
    t.stream(stream(n, "", final=True, exchange="x1"))
    t.event(*call(n, "x1", "c1"))
    t.user("Also mention Rome.")
    t.event(*call(n, "x1", "c1", "ToolCallFinished", result="a.txt"))
    t.event("ModelCallStarted", {"node_id": n, "exchange_id": "x2", "purpose": "chat"})
    t.stream(stream(n, "Rome.", exchange="x2"))
    t.stream(stream(n, "", final=True, exchange="x2"))
    t.event("NodeSucceeded", {"node_id": n, "output": "Rome."})
    messages = store.list_messages(s.id)
    assert [(m.role, [p.text if p.type == "text" else p.state for p in m.parts]) for m in messages] == [
        ("assistant", ["Working", "completed"]), ("user", ["Also mention Rome."]), ("assistant", ["Rome."])]
    assert messages[1].created_at <= messages[2].created_at


def test_a_reply_that_streams_nothing_after_a_user_message_gets_its_output_after_it(setup):
    store, s, t, live = setup
    n = "chat#0/reply"
    t.event("ModelCallStarted", {"node_id": n, "exchange_id": "x1", "purpose": "chat"})
    t.stream(stream(n, "Working", final=True, exchange="x1"))
    t.user("Also mention Rome.")
    t.event("ModelCallStarted", {"node_id": n, "exchange_id": "x2", "purpose": "chat"})
    t.event("NodeSucceeded", {"node_id": n, "output": "Rome."})
    assert [(m.role, [p.text for p in m.parts]) for m in store.list_messages(s.id)] == [
        ("assistant", ["Working"]), ("user", ["Also mention Rome."]), ("assistant", ["Rome."])]


def test_a_user_message_the_reply_never_reads_comes_after_it(setup):
    store, s, t, live = setup
    n = "chat#0/reply"
    t.event("ModelCallStarted", {"node_id": n, "exchange_id": "x1", "purpose": "chat"})
    t.stream(stream(n, "Done.", exchange="x1"))
    t.user("one more thing")
    t.stream(stream(n, "", final=True, exchange="x1"))
    t.event("NodeSucceeded", {"node_id": n, "output": "Done."})
    assert [(m.role, [p.text for p in m.parts]) for m in store.list_messages(s.id)] == [
        ("assistant", ["Done."]), ("user", ["one more thing"])]


def test_an_interrupted_reply_ends_with_the_interrupted_marker(setup):
    store, s, t, live = setup
    n = "chat#0/reply"
    t.event("ModelCallStarted", {"node_id": n, "exchange_id": "x1", "purpose": "chat"})
    t.stream(stream(n, "half a sen", exchange="x1"))
    t.stream(stream(n, "", final=True, exchange="x1"))  # composer closes a cut stream
    t.event("NodeSucceeded", {"node_id": n, "output": "half a sen", "interrupted": True})
    [message] = store.list_messages(s.id)
    assert [p.text for p in message.parts] == ["half a sen" + INTERRUPTED_TEXT]
    assert live[-1].type == "part.updated" and live[-1].data["part"]["text"] == "half a sen" + INTERRUPTED_TEXT


def test_a_reply_interrupted_after_a_tool_call_ends_with_the_marker_after_it(setup):
    store, s, t, live = setup
    n = "chat#0/reply"
    t.event("ModelCallStarted", {"node_id": n, "exchange_id": "x1", "purpose": "chat"})
    t.stream(stream(n, "Working", final=True, exchange="x1"))
    t.event(*call(n, "x1", "c1"))
    t.event(*call(n, "x1", "c1", "ToolCallFinished", result="a.txt"))
    t.event("NodeSucceeded", {"node_id": n, "output": "Working", "interrupted": True})
    [message] = store.list_messages(s.id)
    assert [p.text if p.type == "text" else p.state for p in message.parts] == [
        "Working", "completed", INTERRUPTED_TEXT.lstrip()]


def test_a_reply_interrupted_before_it_streamed_text_gets_its_output_and_the_marker(setup):
    store, s, t, live = setup
    n = "chat#0/reply"
    t.event("ModelCallStarted", {"node_id": n, "exchange_id": "x1", "purpose": "chat"})
    t.event("NodeSucceeded", {"node_id": n, "output": "Working", "interrupted": True})
    [message] = store.list_messages(s.id)
    assert [p.text for p in message.parts] == ["Working" + INTERRUPTED_TEXT]


def test_a_user_message_can_name_its_author(setup):
    store, s, t, live = setup
    t.user("approve it", author="ngocbh")
    t.user("composer message")
    assert [m.author for m in store.list_messages(s.id)] == ["ngocbh", None]


def test_tool_adds_a_part_then_replaces_it_in_place(setup):
    store, s, t, live = setup
    t.event("ModelCallStarted", {"node_id": "turn_1"})
    first = t.tool("turn_1", "item_1", "codex.command", state="running", input={"command": "ls"})
    t.tool("turn_1", "item_1", "codex.command", state="completed", input={"command": "ls", "exit_code": 0},
           output="a\nb")
    [message] = store.list_messages(s.id)
    [part] = message.parts
    assert part.id == first.id and (part.state, part.output, part.input["exit_code"]) == ("completed", "a\nb", 0)
    assert [e.type for e in live][-1] == "part.updated"


def test_a_running_harness_tool_is_interrupted_when_its_turn_ends_interrupted(setup):
    store, s, t, live = setup
    t.event("ModelCallStarted", {"node_id": "turn_1"})
    t.tool("turn_1", "item_1", "codex.command", state="running", input={"command": "sleep 9"})
    t.event("NodeSucceeded", {"node_id": "turn_1", "output": None, "interrupted": True})
    [message] = store.list_messages(s.id)
    assert message.parts[0].state == "interrupted" and message.parts[-1].text.endswith("[interrupted]")


def test_steered_says_whether_a_user_message_came_after_a_nodes_message(setup):
    store, s, t, live = setup
    t.tool("turn_1", "item_1", "codex.command", state="running", input={"command": "ls"})
    assert not t.steered("turn_1")
    t.user("also b", author="ngocbh")
    assert t.steered("turn_1") and not t.steered("turn_2")  # a node with no message yet isn't steered
    t.event("NodeSucceeded", {"node_id": "turn_1", "output": None})
    assert not t.steered("turn_1")

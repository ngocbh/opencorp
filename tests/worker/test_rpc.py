import threading
import time

import pytest
from agent_composer.memory.storage.markdown import MarkdownVersionMismatch
from pydantic import ValidationError

from agent_corp.worker.job import tool_spec
from agent_corp.worker.rpc import BaseHandlers, answer_request, ask_user_stub, model_from_schema, remote_tool

from tests.worker.conftest import office_end


def shout(text: str) -> str:
    """Return text in capitals."""
    return text.upper()


def test_a_remote_tool_runs_in_the_office():
    with office_end(BaseHandlers(tools={"toolbox": {"shout": shout}})) as rpc:
        tool = remote_tool(rpc, "toolbox", tool_spec("shout", shout))
        assert (tool.name, tool.description) == ("shout", "Return text in capitals.")
        assert tool.invoke({"text": "hi"}) == "HI"


def test_a_remote_tool_sends_validated_args_with_defaults():
    seen = []

    def read_file(path: str, offset: int = 0, limit: int | None = None) -> str:
        """Read a file."""
        seen.append((path, offset, limit))
        return "ok"

    with office_end(BaseHandlers(tools={"workspace": {"read_file": read_file}})) as rpc:
        tool = remote_tool(rpc, "workspace", tool_spec("read_file", read_file))
        assert tool.invoke({"path": "a.txt", "limit": 3}) == "ok"
        with pytest.raises(ValidationError):
            tool.invoke({"offset": 1})
    assert seen == [("a.txt", 0, 3)]


def test_an_office_tool_error_is_the_tool_result():
    def boom(text: str) -> str:
        """Fail."""
        raise PermissionError("no grant for boom")

    with office_end(BaseHandlers(tools={"toolbox": {"boom": boom}})) as rpc:
        assert remote_tool(rpc, "toolbox", tool_spec("boom", boom)).invoke({"text": "x"}) == "error: no grant for boom"
        missing = remote_tool(rpc, "toolbox", tool_spec("shout", shout))
        assert missing.invoke({"text": "x"}) == "error: no tool 'shout' in group 'toolbox'"


def test_ask_user_sends_the_six_keys_and_returns_the_answer():
    class Answering(BaseHandlers):
        def ask_user(self, worker, request):
            self.request = request
            return "Paris"

    handlers = Answering()
    with office_end(handlers) as rpc:
        assert ask_user_stub(rpc)(question="Which city?", options=["Paris", "Rome"], node_id=None) == "Paris"
    assert handlers.request == {"question": "Which city?", "questions": None, "answer_schema": None,
                                "title": None, "node_id": None, "options": ["Paris", "Rome"]}
    with office_end(BaseHandlers()) as rpc, pytest.raises(RuntimeError, match="nobody is here"):
        ask_user_stub(rpc)(question="Hello?")


def test_model_from_schema_covers_the_json_types():
    model = model_from_schema("args", {
        "type": "object", "required": ["name"],
        "properties": {"name": {"type": "string", "description": "Who."}, "count": {"type": "integer", "default": 2},
                       "ratio": {"type": "number"}, "on": {"type": "boolean"},
                       "tags": {"type": "array", "items": {"type": "string"}}, "extra": {"type": "object"},
                       "mode": {"enum": ["a", "b"]}, "either": {"type": ["string", "null"]},
                       "maybe": {"anyOf": [{"type": "integer"}, {"type": "null"}], "default": None}}})
    value = model(name="x", ratio=0.5, on=True, tags=["t"], extra={"k": 1}, mode="a", either=None)
    assert value.model_dump() == {"name": "x", "count": 2, "ratio": 0.5, "on": True, "tags": ["t"],
                                  "extra": {"k": 1}, "mode": "a", "either": None, "maybe": None}
    assert model.model_json_schema()["properties"]["name"]["description"] == "Who."
    for bad in [{}, {"name": "x", "tags": "t"}, {"name": "x", "mode": "c"}, {"name": "x", "count": "many"}]:
        with pytest.raises(ValidationError):
            model(**bad)


def test_answer_request_error_codes():
    class Store:
        def read(self, version=None):
            raise LookupError(f"no version {version}")

        def write(self, text, *, base_version, provenance=None):
            raise MarkdownVersionMismatch(base_version, "v2")

    def lookup(key: str) -> str:
        """Look up."""
        return {}[key]

    handlers = BaseHandlers(tools={"g": {"lookup": lookup}}, stores={"profile": Store()})
    read = {"type": "store_read", "id": 1, "store": "profile", "version": "v0"}
    write = {"type": "store_write", "id": 2, "store": "profile", "text": "t", "base_version": "v1"}
    assert answer_request(read, handlers, None) == {"type": "store_reply", "id": 1, "error": "unknown_version",
                                                    "message": "no version v0"}
    reply = answer_request(write, handlers, None)
    assert (reply["error"], reply["expected"], reply["current"]) == ("mismatch", "v1", "v2")
    tool = {"type": "tool_call", "id": 3, "group": "g", "name": "lookup", "args": {"key": "k"}}
    assert answer_request(tool, handlers, None) == {"type": "tool_result", "id": 3, "error": "failed", "message": "'k'"}
    other = answer_request(read | {"store": "other"}, handlers, None)
    assert (other["error"], other["message"]) == ("unavailable", "no store named 'other'")


def test_store_value_and_os_errors_keep_their_codes():
    class Store:
        def read(self, version=None):
            raise UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte")

        def write(self, text, *, base_version, provenance=None):
            raise OSError("git index is locked")

    handlers = BaseHandlers(stores={"profile": Store()})
    read = answer_request({"type": "store_read", "id": 1, "store": "profile"}, handlers, None)
    assert read["error"] == "invalid" and "invalid start byte" in read["message"]
    write = answer_request({"type": "store_write", "id": 2, "store": "profile", "text": "t", "base_version": "v1"},
                           handlers, None)
    assert (write["error"], write["message"]) == ("unavailable", "git index is locked")

    def parse(text: str) -> str:
        """Parse."""
        raise ValueError("bad text")

    tool = answer_request({"type": "tool_call", "id": 3, "group": "g", "name": "parse", "args": {"text": "x"}},
                          BaseHandlers(tools={"g": {"parse": parse}}), None)
    assert (tool["error"], tool["message"]) == ("failed", "bad text")


def test_concurrent_requests_get_their_own_replies():
    def slow(text: str, delay: float) -> str:
        """Echo after a delay."""
        time.sleep(delay)
        return text

    results = {}
    with office_end(BaseHandlers(tools={"g": {"slow": slow}}), threaded=True) as rpc:
        tool = remote_tool(rpc, "g", tool_spec("slow", slow))
        threads = [threading.Thread(target=lambda t=t, d=d: results.update({t: tool.invoke({"text": t, "delay": d})}))
                   for t, d in [("a", 0.3), ("b", 0.0)]]
        for t in threads:
            t.start()
        for t in threads:
            t.join(5)
    assert results == {"a": "a", "b": "b"}

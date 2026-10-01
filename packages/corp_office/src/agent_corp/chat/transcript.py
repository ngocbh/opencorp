"""A session's transcript: Message and Part rows from a run's events, and the live events for them."""

import threading
from collections.abc import Callable
from typing import Any

from agent_corp.protocol import now
from agent_corp.protocol.models import ErrorPart, LiveEvent, Message, TextPart, ToolPart
from agent_corp.store import Store, new_id

_ENDED = ("NodeSucceeded", "NodeSkipped", "NodeFailed")
INTERRUPTED_TEXT = "\n\n[interrupted]"
"""Appended to a text part its worker stopped streaming: a text part has no state to mark."""


class Transcript:
    """Write one session's transcript and publish it live.

    A node gets an assistant message once it calls a model. Each model exchange is a
    text part, stored at its first and last chunk and streamed as ``part.delta`` in
    between; each tool call is a tool part. When the node ends, a tool part still
    running is ``interrupted``, and a node that streamed no text gets its output as text.
    ``abort`` closes what a worker that died or was stopped left open.
    Methods are called from a worker's reader thread and from request threads.
    """

    def __init__(self, store: Store, session_id: str, publish: Callable[[LiveEvent], None]) -> None:
        self.store = store
        self.session_id = session_id
        self._publish = publish
        self._lock = threading.Lock()
        self._messages: dict[str, str] = {}  # node id -> message id
        self._texts: dict[tuple[str, str], TextPart] = {}  # (node id, exchange id) -> part
        self._tools: dict[tuple[str, str], ToolPart] = {}  # (node id, tool call id) -> part
        self._streamed: set[str] = set()  # node ids with a text part

    def user(self, text: str) -> Message:
        """Add a user message."""
        message = self.store.add_message(Message(id=new_id(), session_id=self.session_id, role="user",
                                                 parts=[TextPart(id=new_id(), type="text", text=text)],
                                                 created_at=now()))
        self._live("message.updated", message.model_dump(mode="json"))
        return message

    def error(self, text: str) -> Message:
        """Add an assistant message saying why a turn or the session failed."""
        message = self.store.add_message(Message(id=new_id(), session_id=self.session_id, role="assistant",
                                                 parts=[ErrorPart(id=new_id(), type="error", message=text)],
                                                 created_at=now()))
        self._live("message.updated", message.model_dump(mode="json"))
        return message

    def event(self, name: str, data: dict[str, Any]) -> None:
        """Record a composer event (a worker ``event`` frame's ``name`` and ``data``)."""
        with self._lock:
            if name == "ModelCallStarted":
                self._message(data["node_id"])
            elif name == "ToolCallStarted":
                args = data.get("arguments")
                self._tool(data["node_id"], ToolPart(
                    id=new_id(), type="tool", call_id=data["tool_call_id"], tool=data["name"], state="running",
                    input=args if isinstance(args, dict) else {"arguments": args}))
            elif name == "ToolCallFinished":
                part = self._tools.get((data["node_id"], data["tool_call_id"]))
                if part is not None:
                    error = data.get("error")
                    state = "completed" if error is None else "interrupted" if error == "interrupted" else "error"
                    self._tool(data["node_id"], part.model_copy(update={
                        "state": state, "output": data.get("result") if error is None else {}, "error": error}))
            elif name in _ENDED:
                node_id = data["failure"]["node_id"] if name == "NodeFailed" else data["node_id"]
                if node_id is not None:
                    self._end(node_id, data.get("output") if name == "NodeSucceeded" else None)

    def stream(self, frame: dict[str, Any]) -> None:
        """Record a ``StreamChunk`` (a worker ``stream`` frame); chunks without an exchange id are skipped."""
        exchange = frame.get("exchange_id")
        if exchange is None:
            return
        node_id, key = frame["node_id"], (frame["node_id"], exchange)
        with self._lock:
            part = self._texts.get(key)
            if part is None:
                if not frame["chunk"]:
                    return
                self._texts[key] = TextPart(id=new_id(), type="text", text=frame["chunk"])
                self._streamed.add(node_id)
                self._put(node_id, self._texts[key])
            elif frame["chunk"]:
                part.text += frame["chunk"]
                self._live("part.delta", {"message_id": self._messages[node_id], "part_id": part.id,
                                          "text": frame["chunk"]})
            if frame.get("final") and key in self._texts:
                self._put(node_id, self._texts.pop(key))

    def abort(self) -> None:
        """Store each unfinished text part with ``INTERRUPTED_TEXT`` and each running tool part as interrupted."""
        with self._lock:
            for (node_id, _), part in self._texts.items():
                self._put(node_id, part.model_copy(update={"text": part.text + INTERRUPTED_TEXT}))
            for (node_id, _), part in self._tools.items():
                if part.state == "running":
                    self._put(node_id, part.model_copy(update={"state": "interrupted"}))
            self._texts.clear()
            self._tools.clear()

    def _message(self, node_id: str) -> str:
        if node_id not in self._messages:
            message = self.store.add_message(Message(id=new_id(), session_id=self.session_id, role="assistant",
                                                     parts=[], created_at=now()))
            self._messages[node_id] = message.id
            self._live("message.updated", message.model_dump(mode="json"))
        return self._messages[node_id]

    def _put(self, node_id: str, part: TextPart | ToolPart) -> None:
        message_id = self._message(node_id)
        self.store.put_part(message_id, part)
        self._live("part.updated", {"message_id": message_id, "part": part.model_dump(mode="json")})

    def _tool(self, node_id: str, part: ToolPart) -> None:
        self._tools[(node_id, part.call_id)] = part
        self._put(node_id, part)

    def _end(self, node_id: str, output: Any) -> None:
        if node_id not in self._messages:
            return
        for key in [k for k in self._texts if k[0] == node_id]:
            self._put(node_id, self._texts.pop(key))
        for key in [k for k in self._tools if k[0] == node_id]:
            part = self._tools.pop(key)
            if part.state == "running":
                self._put(node_id, part.model_copy(update={"state": "interrupted"}))
        if node_id not in self._streamed and isinstance(output, str) and output:
            self._put(node_id, TextPart(id=new_id(), type="text", text=output))
        self._streamed.discard(node_id)
        del self._messages[node_id]

    def _live(self, type_: str, data: dict[str, Any]) -> None:
        self._publish(LiveEvent(type=type_, session_id=self.session_id, data=data))

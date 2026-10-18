"""A session's transcript: Message and Part rows from a run's events, and the live events for them."""

import threading
from collections.abc import Callable
from typing import Any, Literal

from opencorp.protocol import now
from opencorp.protocol.models import ErrorPart, LiveEvent, Message, TextPart, ToolPart
from opencorp.store import Store, new_id

_ENDED = ("NodeSucceeded", "NodeSkipped", "NodeFailed")
INTERRUPTED_TEXT = "\n\n[interrupted]"
"""Ends a reply that was stopped short, on its last text part: a text part has no state to mark."""

ToolState = Literal["pending", "running", "completed", "error", "interrupted"]
"""A tool part's states, as ``ToolPart.state`` takes them."""


class Transcript:
    """Write one session's transcript and publish it live.

    A node gets an assistant message once it calls a model. Each model exchange is a
    text part, stored at its first and last chunk and streamed as ``part.delta`` in
    between; each tool call is a tool part. When the node ends, a tool part still
    running is ``interrupted``, a node that streamed no text gets its output as text, and
    a node an interrupt stopped ends with ``INTERRUPTED_TEXT``.
    A user message that comes in while a node runs (a steer) closes the node's message at
    its next model call, so what the model says after reading it follows it.
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
        self._streamed: set[str] = set()  # node ids whose message has a text part
        self._steered: set[str] = set()  # node ids with a user message after their message
        self._tails: dict[str, TextPart | ToolPart] = {}  # node id -> its message's last part

    def user(self, text: str, *, author: str | None = None) -> Message:
        """Add a user message; ``author`` is the human who sent it (a harness session names every sender)."""
        with self._lock:
            message = self.store.add_message(Message(id=new_id(), session_id=self.session_id, role="user",
                                                     parts=[TextPart(id=new_id(), type="text", text=text)],
                                                     author=author, created_at=now()))
            self._steered.update(self._messages)
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
                if data["node_id"] in self._steered:
                    self._close(data["node_id"])
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
                    self._end(node_id, data.get("output") if name == "NodeSucceeded" else None,
                              data.get("interrupted", False))

    def tool(self, node_id: str, call_id: str, tool: str, *, state: ToolState, input: dict[str, Any],
             output: Any = None, error: str | None = None) -> ToolPart:
        """Add the tool part ``call_id`` to ``node_id``'s message, or replace it in place: a harness's own tool items,
        which arrive as updates rather than composer's start and finish events.

        The part is validated before anything is kept or stored, so a bad one changes nothing. Once ``node_id``
        has ended, an update starts a new message, so callers send none after their turn ends. The returned part
        is the one the transcript keeps; don't change it.
        """
        with self._lock:
            existing = self._tools.get((node_id, call_id))
            part = ToolPart(id=existing.id if existing else new_id(), type="tool", call_id=call_id, tool=tool,
                            state=state, input=input, output={} if output is None else output, error=error)
            self._tool(node_id, part)
            return part

    def steered(self, node_id: str) -> bool:
        """Whether a user message came in after ``node_id``'s message: a harness puts what it does next in a new one."""
        with self._lock:
            return node_id in self._steered

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
        self._tails[node_id] = part
        self._live("part.updated", {"message_id": message_id, "part": part.model_dump(mode="json")})

    def _tool(self, node_id: str, part: ToolPart) -> None:
        self._tools[(node_id, part.call_id)] = part
        self._put(node_id, part)

    def _close(self, node_id: str) -> None:
        # Called between model calls or once _end stored what was open, so this drops nothing open.
        for key in [k for k in self._tools if k[0] == node_id]:
            del self._tools[key]
        self._streamed.discard(node_id)
        self._steered.discard(node_id)
        self._tails.pop(node_id, None)
        del self._messages[node_id]

    def _end(self, node_id: str, output: Any, interrupted: bool) -> None:
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
        if interrupted:
            tail = self._tails.get(node_id)
            if isinstance(tail, TextPart):
                self._put(node_id, tail.model_copy(update={"text": tail.text + INTERRUPTED_TEXT}))
            else:
                self._put(node_id, TextPart(id=new_id(), type="text", text=INTERRUPTED_TEXT.lstrip()))
        self._close(node_id)

    def _live(self, type_: str, data: dict[str, Any]) -> None:
        self._publish(LiveEvent(type=type_, session_id=self.session_id, data=data))

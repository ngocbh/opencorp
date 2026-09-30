"""Request/reply calls over a worker channel, and the office-side handler interface."""

import itertools
import logging
import threading
from collections.abc import Callable, Mapping
from concurrent.futures import Future
from typing import Any, Literal, Protocol, Union

from agent_composer.memory.storage.markdown import MarkdownStore, MarkdownVersionMismatch
from langchain_core.tools import BaseTool, StructuredTool, ToolException
from pydantic import BaseModel, Field, create_model

from agent_corp.worker.channel import Channel, jsonable
from agent_corp.worker.job import ToolSpec

log = logging.getLogger(__name__)

# The keywords composer passes to an ask_user handler.
ASK_KEYS = ("question", "questions", "answer_schema", "title", "node_id", "options")
# Worker -> office request frame type -> office -> worker reply frame type.
REQUEST_REPLIES = {"ask_user": "answer", "tool_call": "tool_result",
                   "store_read": "store_reply", "store_write": "store_reply"}
REPLY_TYPES = frozenset(REQUEST_REPLIES.values())


class RemoteError(Exception):
    """The office answered a request with an error reply."""

    def __init__(self, reply: Mapping[str, Any]) -> None:
        super().__init__(reply.get("message") or reply["error"])
        self.code: str = reply["error"]
        self.reply = dict(reply)


class Rpc:
    """Numbered requests over a channel; a reader thread hands replies to ``deliver``."""

    def __init__(self, channel: Channel) -> None:
        self.channel = channel
        self._ids = itertools.count(1)
        self._lock = threading.Lock()
        self._waiting: dict[int, Future[dict[str, Any]]] = {}

    def request(self, type_: str, **fields: Any) -> dict[str, Any]:
        """Send a request frame and block for its reply; raise ``RemoteError`` for an error reply."""
        future: Future[dict[str, Any]] = Future()
        with self._lock:
            request_id = next(self._ids)
            self._waiting[request_id] = future
        try:
            self.channel.send({"type": type_, "id": request_id, **fields})
            reply = future.result()
        finally:
            with self._lock:
                self._waiting.pop(request_id, None)
        if "error" in reply:
            raise RemoteError(reply)
        return reply

    def deliver(self, frame: dict[str, Any]) -> bool:
        """Complete the request ``frame`` answers; False if none is waiting."""
        with self._lock:
            future = self._waiting.get(frame.get("id"))  # type: ignore[arg-type]
        if future is None:
            return False
        future.set_result(frame)
        return True


_TYPES: dict[str, Any] = {"string": str, "integer": int, "number": float, "boolean": bool,
                          "null": type(None), "object": dict[str, Any]}


def _annotation(schema: Mapping[str, Any]) -> Any:
    if "anyOf" in schema:
        options = tuple(_annotation(s) for s in schema["anyOf"])
        return Union[options] if len(options) > 1 else options[0]  # noqa: UP007
    kind = schema.get("type")
    if isinstance(kind, list):
        return Union[tuple(_annotation({**schema, "type": k}) for k in kind)]  # noqa: UP007
    if "enum" in schema:
        return Literal[tuple(schema["enum"])]
    if kind == "array":
        return list[_annotation(schema.get("items", {}))]
    return _TYPES.get(kind, Any)


def model_from_schema(name: str, schema: Mapping[str, Any]) -> type[BaseModel]:
    """A pydantic model for a JSON-schema object: its properties, required fields, and defaults."""
    required = set(schema.get("required", []))
    fields: dict[str, Any] = {}
    for key, prop in schema.get("properties", {}).items():
        default = ... if key in required else prop.get("default")
        fields[key] = (_annotation(prop), Field(default, description=prop.get("description")))
    return create_model(name, **fields)


def remote_tool(rpc: Rpc, group: str, spec: ToolSpec) -> StructuredTool:
    """A tool that runs ``spec`` in the office: one ``tool_call`` frame per call.

    An error reply becomes the tool's result text (``error: <message>``), so the model
    sees it and the run goes on.
    """

    def call(**args: Any) -> Any:
        try:
            reply = rpc.request("tool_call", group=group, name=spec.name, args=jsonable(args))
        except RemoteError as exc:
            raise ToolException(f"error: {exc}") from exc
        return reply.get("result")

    return StructuredTool.from_function(func=call, name=spec.name, description=spec.description or spec.name,
                                        args_schema=model_from_schema(f"{spec.name}_args", spec.parameters),
                                        handle_tool_error=True)


def ask_user_stub(rpc: Rpc) -> Callable[..., Any]:
    """composer's ``ask_user`` handler, answered by the office through an ``ask_user`` frame."""

    def ask_user(**request: Any) -> Any:
        try:
            reply = rpc.request("ask_user", request=jsonable({k: request.get(k) for k in ASK_KEYS}))
        except RemoteError as exc:
            raise RuntimeError(f"ask_user failed: {exc}") from exc
        return reply.get("answer")

    return ask_user


class WorkerHandlers(Protocol):
    """What the office does with a worker's frames. ``worker`` is the ``spawn.Worker``.

    Notifications (``event`` through ``exited``) run on the worker's reader thread, in
    frame order, and must not block. Requests (``ask_user`` through ``store_write``) run
    on their own threads and may block; what they return is the reply, and what they
    raise becomes an error reply.
    """

    def event(self, worker: Any, frame: dict[str, Any]) -> None:
        """A composer ``on_event`` observer: ``{"name": class name, "data": fields}``."""

    def stream(self, worker: Any, frame: dict[str, Any]) -> None:
        """A composer ``StreamChunk``'s fields."""

    def steer_left(self, worker: Any, node_id: str, texts: list[str]) -> None:
        """Steer messages the run did not read before ``node_id`` finished (or already had)."""

    def result(self, worker: Any, frame: dict[str, Any]) -> None:
        """The job finished: ``status``, ``run_id``, ``output``, ``failure``, ``backward``."""

    def error(self, worker: Any, frame: dict[str, Any]) -> None:
        """The job raised before it could finish: ``message`` and ``traceback``."""

    def exited(self, worker: Any, returncode: int) -> None:
        """The worker process is gone; called once, last."""

    def ask_user(self, worker: Any, request: dict[str, Any]) -> Any:
        """Answer a question; ``request`` has the ``ASK_KEYS``."""

    def tool_call(self, worker: Any, group: str, name: str, args: dict[str, Any]) -> Any:
        """Run tool ``name`` of ``group`` with ``args``; the result must be JSON data."""

    def store_read(self, worker: Any, store: str, version: str | None) -> tuple[str, str]:
        """``MarkdownStore.read`` on the office store named ``store``."""

    def store_write(self, worker: Any, store: str, text: str, base_version: str,
                    provenance: dict[str, Any] | None) -> str:
        """``MarkdownStore.write`` on the office store named ``store``."""


class BaseHandlers:
    """Handlers that ignore notifications, refuse questions, and serve the given tools and stores.

    ``tools`` is ``{group: {name: function or BaseTool}}``; ``stores`` is ``{name: MarkdownStore}``.
    Subclass it and override what you need.
    """

    def __init__(self, *, tools: Mapping[str, Mapping[str, Any]] | None = None,
                 stores: Mapping[str, MarkdownStore] | None = None) -> None:
        self.tools = {group: dict(named) for group, named in (tools or {}).items()}
        self.stores = dict(stores or {})

    def event(self, worker: Any, frame: dict[str, Any]) -> None:
        pass

    def stream(self, worker: Any, frame: dict[str, Any]) -> None:
        pass

    def steer_left(self, worker: Any, node_id: str, texts: list[str]) -> None:
        pass

    def result(self, worker: Any, frame: dict[str, Any]) -> None:
        pass

    def error(self, worker: Any, frame: dict[str, Any]) -> None:
        pass

    def exited(self, worker: Any, returncode: int) -> None:
        pass

    def ask_user(self, worker: Any, request: dict[str, Any]) -> Any:
        raise RuntimeError("nobody is here to answer")

    def tool_call(self, worker: Any, group: str, name: str, args: dict[str, Any]) -> Any:
        try:
            tool = self.tools[group][name]
        except KeyError:
            raise RuntimeError(f"no tool {name!r} in group {group!r}") from None
        return tool.invoke(args) if isinstance(tool, BaseTool) else tool(**args)

    def store_read(self, worker: Any, store: str, version: str | None) -> tuple[str, str]:
        return self._store(store).read(version)

    def store_write(self, worker: Any, store: str, text: str, base_version: str,
                    provenance: dict[str, Any] | None) -> str:
        return self._store(store).write(text, base_version=base_version, provenance=provenance)

    def _store(self, name: str) -> MarkdownStore:
        try:
            return self.stores[name]
        except KeyError:
            raise OSError(f"no store named {name!r}") from None


def answer_request(frame: dict[str, Any], handlers: WorkerHandlers, worker: Any) -> dict[str, Any]:
    """The reply frame for a worker's request frame, from ``handlers``.

    A handler's exception becomes ``{"error": code, "message"}``: ``mismatch`` (with
    ``expected`` and ``current``) for ``MarkdownVersionMismatch``, ``unknown_version``
    for a ``LookupError`` from a store, and ``failed`` for anything else.
    """
    kind = frame["type"]
    head = {"type": REQUEST_REPLIES[kind], "id": frame["id"]}
    try:
        if kind == "ask_user":
            return head | {"answer": jsonable(handlers.ask_user(worker, frame["request"]))}
        if kind == "tool_call":
            result = handlers.tool_call(worker, frame["group"], frame["name"], frame.get("args") or {})
            return head | {"result": jsonable(result)}
        if kind == "store_read":
            text, version = handlers.store_read(worker, frame["store"], frame.get("version"))
            return head | {"text": text, "version": version}
        version = handlers.store_write(worker, frame["store"], frame["text"], frame["base_version"],
                                       frame.get("provenance"))
        return head | {"version": version}
    except MarkdownVersionMismatch as exc:
        return head | {"error": "mismatch", "message": str(exc), "expected": exc.expected, "current": exc.current}
    except LookupError as exc:
        if kind.startswith("store_"):
            return head | {"error": "unknown_version", "message": str(exc)}
        return head | _failed(kind, exc)
    except Exception as exc:
        return head | _failed(kind, exc)


def _failed(kind: str, exc: Exception) -> dict[str, Any]:
    log.info("worker %s request failed", kind, exc_info=exc)
    return {"error": "failed", "message": str(exc) or type(exc).__name__}

"""Codex app-server items and server requests, as the office's transcript parts and question cards.

A turn's items share one assistant message until a user message comes in mid-turn (a steer): the next item that
starts then opens a new message, so what Codex does after reading the steer follows it. An item that started before
the steer keeps writing to the message it started in, so its later deltas, its completion and any decision on it land
on its own part. An interrupted turn ends with ``[interrupted]``.
"""

import json
import logging
import os
from typing import Any

from agent_corp.chat.transcript import Transcript

log = logging.getLogger(__name__)

OUTPUT_MAX_CHARS = 20_000
OUTPUT_CUT = "\n[output cut here; Codex keeps all of it]"
COMMAND, FILE_CHANGE, MCP_TOOL, REQUEST = "codex.command", "codex.file_change", "codex.mcp_tool_call", "codex.request"
"""Tool names of Codex's parts; the debrief and the TUI key on the ``codex.`` prefix."""
TOOL_ITEMS = {"commandExecution": COMMAND, "fileChange": FILE_CHANGE, "mcpToolCall": MCP_TOOL}
_STATES = {"inProgress": "running", "completed": "completed", "failed": "error", "declined": "error"}


def cap(text: str | None) -> str:
    """``text`` cut to ``OUTPUT_MAX_CHARS`` with a marker; Codex keeps the whole of it."""
    text = text or ""
    return text if len(text) <= OUTPUT_MAX_CHARS else text[:OUTPUT_MAX_CHARS] + OUTPUT_CUT


def relative(path: str, cwd: str | None) -> str:
    """``path`` relative to ``cwd`` when it lies under it, else as sent: Codex sends a file change's absolute path."""
    if not cwd or not os.path.isabs(path):
        return path
    for root in dict.fromkeys((cwd, os.path.realpath(cwd))):  # Codex may report /private/tmp for /tmp
        if path.startswith(root.rstrip("/") + "/"):
            return os.path.relpath(path, root)
    return path


def change_counts(kind: str | None, diff: str | None) -> tuple[int, int]:
    """Lines one Codex file change adds and removes.

    Codex sends a new or deleted file's whole content as ``diff``, and a unified diff only for an update.
    """
    lines = (diff or "").splitlines()
    if kind == "add":
        return len(lines), 0
    if kind == "delete":
        return 0, len(lines)
    return (sum(1 for x in lines if x.startswith("+") and not x.startswith("+++")),
            sum(1 for x in lines if x.startswith("-") and not x.startswith("---")))


class Translator:
    """Write one Codex thread's items into a session's transcript. Methods run on the session's own thread.

    ``cwd`` is the session's: file changes under it are named relative to it.
    """

    def __init__(self, transcript: Transcript, cwd: str | None = None) -> None:
        self.transcript, self.cwd = transcript, cwd
        self._streamed: dict[str, int] = {}  # agent message item id -> characters streamed so far
        self._items: dict[str, dict[str, Any]] = {}  # tool item id -> its latest item, for cards and decisions
        self._segments: dict[str, list[str]] = {}  # turn id -> the transcript node of each of its messages
        self._nodes: dict[str, str] = {}  # item or request part id -> the node of the message it started in
        self._shown: dict[str, str] = {}  # turn id -> the last error message shown for it
        self._after_error: set[str] = set()  # turn ids whose next item goes below an error shown mid-turn

    def notification(self, method: str, params: dict[str, Any]) -> bool:
        """Write an item notification into the transcript; False for a method that isn't the translator's."""
        if method == "item/agentMessage/delta":
            node = self._node(params["turnId"], params["itemId"])
            self._streamed[params["itemId"]] = self._streamed.get(params["itemId"], 0) + len(params["delta"])
            self.transcript.stream({"node_id": node, "exchange_id": params["itemId"], "chunk": params["delta"]})
        elif method in ("item/started", "item/completed"):
            self._item(params["turnId"], params["item"], done=method == "item/completed")
        elif method == "error":
            self._error(params)
        else:
            return False
        return True

    def turn_completed(self, turn_id: str, status: str, error: dict[str, Any] | None) -> None:
        """Close the turn's messages: running tools become interrupted, and an interrupted turn gets the marker on its
        newest message (a new one when nothing ran, or when a steer came after the newest)."""
        interrupted = status == "interrupted"
        if interrupted:
            self.transcript.event("ModelCallStarted", {"node_id": self._current(turn_id)})
        self._finish(turn_id, interrupted)
        shown = self._shown.pop(turn_id, None)
        why = (error or {}).get("message") or "no reason given"
        if status == "failed" and why != shown:  # Codex often sends the same message as an error first
            self.transcript.error(f"Codex's turn failed: {why}")

    def _finish(self, turn_id: str, interrupted: bool) -> None:
        """Close every message of ``turn_id``; only the newest gets the marker."""
        segments = self._segments.pop(turn_id, [])
        for node in segments:
            self.transcript.event("NodeSucceeded", {"node_id": node, "output": None,
                                                    "interrupted": interrupted and node == segments[-1]})
        self._nodes = {key: node for key, node in self._nodes.items() if node not in segments}
        self._after_error.discard(turn_id)

    def _current(self, turn_id: str) -> str:
        """The node of the turn's newest message, or of a new one when there is none, or a steer or an error message
        came after it."""
        segments = self._segments.setdefault(turn_id, [])
        if not segments or self.transcript.steered(segments[-1]) or turn_id in self._after_error:
            self._after_error.discard(turn_id)
            segments.append(turn_id if not segments else f"{turn_id}~{len(segments)}")
        return segments[-1]

    def _node(self, turn_id: str, key: str) -> str:
        """The node ``key`` (an item, or a request's own part) writes under: the message it started in."""
        if key not in self._nodes:
            self._nodes[key] = self._current(turn_id)
        return self._nodes[key]

    def _item(self, turn_id: str, item: dict[str, Any], *, done: bool) -> None:
        kind = item.get("type")
        if kind not in TOOL_ITEMS and kind not in ("agentMessage", "reasoning"):
            if kind != "userMessage":
                log.debug("codex: an item the transcript doesn't show: %s", kind)
            return
        node = self._node(turn_id, item["id"])
        if kind == "agentMessage" and done:
            sent = self._streamed.pop(item["id"], 0)
            self.transcript.stream({"node_id": node, "exchange_id": item["id"], "chunk": item["text"][sent:],
                                    "final": True})
        elif kind == "reasoning" and done and item.get("summary"):
            self.transcript.stream({"node_id": node, "exchange_id": item["id"], "final": True,
                                    "chunk": "(thinking) " + "\n".join(item["summary"])})
        elif kind in TOOL_ITEMS:
            if kind == "fileChange":  # named once here, so the card, the part, the debrief and the TUI all agree
                item = {**item, "changes": [{**c, "path": relative(c["path"], self.cwd)}
                                            for c in item.get("changes", [])]}
            self._items[item["id"]] = item
            self._put(turn_id, item["id"])

    def _error(self, params: dict[str, Any]) -> None:
        message = (params.get("error") or {}).get("message") or "an error with no message"
        if params.get("willRetry"):
            log.info("codex: %s (Codex retries)", message)
            return
        self._shown[params["turnId"]] = message
        self.transcript.error(f"Codex: {message}")
        self._after_error.add(params["turnId"])  # what Codex does next goes below the error, not above it

    def _put(self, turn_id: str, call_id: str) -> None:
        """(Re)write ``call_id``'s tool part from its item."""
        tool, input_, output, error = _view(self._items[call_id])
        self.transcript.tool(self._node(turn_id, call_id), call_id, tool,
                             state=_STATES.get(self._items[call_id].get("status"), "running"), input=input_,
                             output=output, error=error)


def _kind(change: dict[str, Any]) -> str | None:
    return (change.get("kind") or {}).get("type")


def _view(item: dict[str, Any]) -> tuple[str, dict[str, Any], Any, str | None]:
    """A tool item's part fields: tool, input, output, error."""
    kind, status = item["type"], item.get("status")
    error = "declined" if status == "declined" else None
    if kind == "commandExecution":
        return (COMMAND, {"command": item["command"], "cwd": item.get("cwd"), "exit_code": item.get("exitCode")},
                cap(item.get("aggregatedOutput")), error)
    if kind == "fileChange":
        changes = [{"path": c["path"], "kind": _kind(c), "diff": cap(c.get("diff"))} for c in item.get("changes", [])]
        return FILE_CHANGE, {"changes": changes}, "", error
    result, failure = item.get("result"), item.get("error")
    output = cap(json.dumps(result.get("content"), ensure_ascii=False)) if result else ""
    return (MCP_TOOL, {"server": item["server"], "tool": item["tool"], "arguments": item.get("arguments")}, output,
            failure.get("message") if failure else error)

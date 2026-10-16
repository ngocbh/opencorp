"""Codex app-server items and server requests, as the office's transcript parts and question cards.

A turn's items share one assistant message until a user message comes in mid-turn (a steer): the next item that
starts then opens a new message, so what Codex does after reading the steer follows it. An item that started before
the steer keeps writing to the message it started in, so its later deltas, its completion and any decision on it land
on its own part. An interrupted turn ends with ``[interrupted]``.
"""

import logging
from typing import Any

from agent_corp.chat.transcript import Transcript

log = logging.getLogger(__name__)


class Translator:
    """Write one Codex thread's items into a session's transcript. Methods run on the session's own thread.

    ``cwd`` is the session's: file changes under it are named relative to it.
    """

    def __init__(self, transcript: Transcript, cwd: str | None = None) -> None:
        self.transcript, self.cwd = transcript, cwd
        self._streamed: dict[str, int] = {}  # agent message item id -> characters streamed so far
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
        if kind not in ("agentMessage", "reasoning"):
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

    def _error(self, params: dict[str, Any]) -> None:
        message = (params.get("error") or {}).get("message") or "an error with no message"
        if params.get("willRetry"):
            log.info("codex: %s (Codex retries)", message)
            return
        self._shown[params["turnId"]] = message
        self.transcript.error(f"Codex: {message}")
        self._after_error.add(params["turnId"])  # what Codex does next goes below the error, not above it

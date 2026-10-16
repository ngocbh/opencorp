"""Codex app-server items and server requests, as the office's transcript parts and question cards.

A turn's items share one assistant message until a user message comes in mid-turn (a steer): the next item that
starts then opens a new message, so what Codex does after reading the steer follows it. An item that started before
the steer keeps writing to the message it started in, so its later deltas, its completion and any decision on it land
on its own part. An interrupted turn ends with ``[interrupted]``.
"""

import json
import logging
import os
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from agent_corp.chat.transcript import Transcript
from agent_corp.protocol import now
from agent_corp.protocol.models import AnswerField, Question, QuestionOption, QuestionPage, Session
from agent_corp.store import new_id

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
        self._finished: deque[str] = deque(maxlen=16)  # the latest finished turns, whose late messages are dropped

    def notification(self, method: str, params: dict[str, Any]) -> bool:
        """Write an item notification into the transcript; False for a method that isn't the translator's."""
        if method not in ("item/agentMessage/delta", "item/started", "item/completed", "error"):
            return False
        if params.get("turnId") in self._finished:  # its messages are closed: writing would open a new one
            log.debug("codex: %s for turn %s, which has ended", method, params.get("turnId"))
            return True
        if method == "item/agentMessage/delta":
            node = self._node(params["turnId"], params["itemId"])
            self._streamed[params["itemId"]] = self._streamed.get(params["itemId"], 0) + len(params["delta"])
            self.transcript.stream({"node_id": node, "exchange_id": params["itemId"], "chunk": params["delta"]})
        elif method in ("item/started", "item/completed"):
            self._item(params["turnId"], params["item"], done=method == "item/completed")
        else:
            self._error(params)
        return True

    def turn_completed(self, turn_id: str, status: str, error: dict[str, Any] | None) -> None:
        """Close the turn's messages: running tools become interrupted, and an interrupted turn gets the marker on its
        newest message (a new one when nothing ran, or when a steer came after the newest)."""
        interrupted = status == "interrupted"
        if interrupted:
            self.transcript.event("ModelCallStarted", {"node_id": self._current(turn_id)})
        shown = self._shown.get(turn_id)
        self._finish(turn_id, interrupted)
        why = (error or {}).get("message") or "no reason given"
        if status == "failed" and why != shown:  # Codex often sends the same message as an error first
            self.transcript.error(f"Codex's turn failed: {why}")

    def _finish(self, turn_id: str, interrupted: bool) -> None:
        """Close every message of ``turn_id``; only the newest gets the marker."""
        segments = self._segments.pop(turn_id, [])
        for node in segments:
            self.transcript.event("NodeSucceeded", {"node_id": node, "output": None,
                                                    "interrupted": interrupted and node == segments[-1]})
        done = {key for key, node in self._nodes.items() if node in segments}
        for key in done:
            self._items.pop(key, None)
            self._streamed.pop(key, None)
            del self._nodes[key]
        self._shown.pop(turn_id, None)
        self._after_error.discard(turn_id)
        self._finished.append(turn_id)

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

    # --- cards ----------------------------------------------------------------------

    def card(self, method: str, params: dict[str, Any], *, session: Session, run_id: str, node_id: str) -> "Card":
        """The card for a server request; ``Unserved`` for a method that isn't one."""
        t = now()
        base = {"id": new_id(), "session_id": session.id, "run_id": run_id, "node_id": node_id, "source": "harness",
                "asker": session.person, "work_item_id": session.work_item_id, "status": "open", "created_at": t,
                "updated_at": t}
        if method == "item/commandExecution/requestApproval":
            network = params.get("networkApprovalContext")
            if network:  # a managed-network prompt: Codex sends no command or cwd, only the host
                title, text = "Codex wants network access", f"{network['protocol']} to {network['host']}"
            else:
                item = self._items.get(params["itemId"], {})
                command, cwd = params.get("command") or item.get("command") or "?", params.get("cwd") or item.get("cwd")
                title = _COMMAND_TITLES.get(params.get("kind"), _COMMAND_TITLES["command"])
                text = f"$ {command}\nin {cwd}"
                if asked := _pruned(params.get("additionalPermissions")):
                    text += f"\nand asks for {json.dumps(asked)}"
            return self._approval("command", base, params, title, text,
                                  _offered(params.get("availableDecisions"), _APPROVE))
        if method == "item/fileChange/requestApproval":
            changes = self._items.get(params["itemId"], {}).get("changes", [])
            text = "\n".join(f"{c['path']} ({_kind(c)}, +{a}/-{b})" for c in changes
                             for a, b in [change_counts(_kind(c), c.get("diff"))])
            if params.get("grantRoot"):
                text += f"\nand write access under {params['grantRoot']} for this session"
            return self._approval("file_change", base, params, "Codex wants to change files", text or "(no diff yet)",
                                  _APPROVE)
        if method == "item/permissions/requestApproval":
            asked = {k: v for k, v in params["permissions"].items() if v is not None}
            text = f"{json.dumps(asked)}\nin {params.get('cwd')}"

            def grant(d: str) -> dict[str, Any]:
                return {"permissions": {}, "scope": "turn"} if d == "decline" else {"permissions": asked, "scope": d}

            q = Question.model_validate({**base, "title": "Codex asks for more permissions",
                                         "question": _with_reason(text, params),
                                         "options": [x for x, _ in _PERMISSIONS]})
            return Card("permissions", q, params["itemId"], _choice(_PERMISSIONS, grant))
        return self._other(method, params, base)

    def _approval(self, kind: str, base: dict[str, Any], params: dict[str, Any], title: str, text: str,
                  options: list[tuple[str, str]]) -> "Card":
        q = Question.model_validate({**base, "title": title, "question": _with_reason(text, params),
                                     "options": [label for label, _ in options]})
        return Card(kind, q, params["itemId"], _choice(options, lambda d: {"decision": d}))

    def _other(self, method: str, params: dict[str, Any], base: dict[str, Any]) -> "Card":
        if method == "item/tool/requestUserInput":
            questions = params["questions"]
            mcp = next((q for q in questions if q["id"].startswith(MCP_APPROVAL_PREFIX)), None)
            if mcp is not None:
                labels = [o["label"] for o in mcp.get("options") or [] if o["label"] != _REMEMBER]
                options = [(label, d) for label, d in _MCP if label in labels]
                q = Question.model_validate({**base, "title": mcp["header"], "question": mcp["question"],
                                             "options": [x for x, _ in options]})
                return Card("mcp_tool", q, params["itemId"],
                            _choice(options, lambda d: {"answers": {mcp["id"]: {"answers": [_label(options, d)]}}}))
            return self._pages(base, params, questions)
        if method == "mcpServer/elicitation/request":
            if params.get("mode") not in ("form", "url"):  # e.g. a device verification, which needs a proof
                raise Unserved(f"{method} in mode {params.get('mode')}")
            meta = params.get("_meta") or {}
            title = f"{params['serverName']}: {params['message']}"
            if meta.get("codex_approval_kind"):
                persist = meta.get("persist")
                offers_session = persist == "session" or (isinstance(persist, list) and "session" in persist)
                options = [(x, d) for x, d in _MCP if d != "acceptForSession" or offers_session]
                q = Question.model_validate({**base, "title": _APPROVAL_TITLES.get(meta["codex_approval_kind"],
                                                                                   "Codex asks about an MCP server"),
                                             "question": title, "options": [x for x, _ in options]})

                def mcp_reply(d: str) -> dict[str, Any]:
                    if d == "cancel":
                        return {"action": "cancel"}
                    session_wide = {"_meta": {"persist": "session"}} if d == "acceptForSession" else {}
                    return {"action": "accept", **session_wide}

                return Card("mcp_tool", q, f"request-{base['node_id']}", _choice(options, mcp_reply))
            return self._elicitation(base, params, title)
        raise Unserved(method)

    def _pages(self, base: dict[str, Any], params: dict[str, Any], questions: list[dict[str, Any]]) -> "Card":
        if len(questions) > _MAX_PAGES:
            raise Unserved("item/tool/requestUserInput with more than four questions")
        headers: dict[str, str] = {}  # page header -> Codex question id
        pages, schema = [], []
        for q in questions:
            header = q["header"] or q["id"]
            while header in headers:  # headers key the answer record, so they must differ
                header += "'"
            headers[header] = q["id"]
            options = [QuestionOption(label=o["label"], description=o.get("description") or "")
                       for o in q.get("options") or []]
            pages.append(QuestionPage(question=q["question"], header=header, options=options,
                                      secret=bool(q.get("isSecret"))))
            if options and not q.get("isOther"):
                schema.append(AnswerField(name=header, type="str", required=True, enum=[o.label for o in options]))
        question = Question.model_validate({**base, "title": "Codex asks", "question": pages[0].question,
                                            "questions": pages, "answer_schema": schema})

        def reply(answer: dict[str, Any]) -> tuple[dict[str, Any], str]:
            return {"answers": {headers[h]: {"answers": v if isinstance(v, list) else [v]}
                                for h, v in answer.items()}}, "answer"

        secret = frozenset(p.header for p in pages if p.secret)
        return Card("question", question, params["itemId"], reply, secret)

    def _elicitation(self, base: dict[str, Any], params: dict[str, Any], title: str) -> "Card":
        call_id = f"request-{base['node_id']}"
        url = params["mode"] == "url"
        props = {} if url else (params.get("requestedSchema") or {}).get("properties") or {}
        if not props:
            options = [("Done" if url else "Accept", "accept"), ("Decline", "decline"), ("Cancel", "cancel")]
            q = Question.model_validate({**base, "title": "An MCP server asks",
                                         "question": f"{title}\n{params['url']}" if url else title,
                                         "options": [x for x, _ in options]})
            return Card("elicitation", q, call_id, _choice(options, lambda d: {"action": d}))
        pages, schema = [], []
        for name, spec in list(props.items())[:_MAX_PAGES]:
            labels = spec.get("enum") or (["Yes", "No"] if spec.get("type") == "boolean" else [])
            pages.append(QuestionPage(question=spec.get("description") or spec.get("title") or name, header=name,
                                      options=[QuestionOption(label=x) for x in labels]))
            if labels:  # a field with choices takes only them
                schema.append(AnswerField(name=name, type="str", required=True, enum=labels))
            elif spec.get("type") in _NUMBERS:  # check_answer converts typed text, or refuses it before Codex sees it
                schema.append(AnswerField(name=name, type=_NUMBERS[spec["type"]], required=True))
        q = Question.model_validate({**base, "title": "An MCP server asks", "question": title, "questions": pages,
                                     "answer_schema": schema})

        def reply(answer: dict[str, Any]) -> tuple[dict[str, Any], str]:
            return {"action": "accept", "content": {k: _typed(props[k], v) for k, v in answer.items()}}, "accept"

        return Card("elicitation", q, call_id, reply)


SERVED = frozenset({"item/commandExecution/requestApproval", "item/fileChange/requestApproval",
                    "item/permissions/requestApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request"})
"""Server requests that become cards."""
REFUSED = frozenset({"item/tool/call", "account/chatgptAuthTokens/refresh", "attestation/generate", "currentTime/read",
                     "applyPatchApproval", "execCommandApproval"})
"""Server requests the office answers with a JSON-RPC error: the pinned schema's others (the drift test checks)."""
REPLY_SCHEMAS = {"item/commandExecution/requestApproval": "CommandExecutionRequestApprovalResponse",
                 "item/fileChange/requestApproval": "FileChangeRequestApprovalResponse",
                 "item/permissions/requestApproval": "PermissionsRequestApprovalResponse",
                 "item/tool/requestUserInput": "ToolRequestUserInputResponse",
                 "mcpServer/elicitation/request": "McpServerElicitationRequestResponse"}
"""The pinned response schema each served request's reply must match."""

_APPROVE = [("Approve", "accept"), ("Approve for this session", "acceptForSession"),
            ("Deny so Codex continues", "decline"), ("Deny and stop", "cancel")]
_COMMAND_TITLES = {"command": "Codex wants to run a command",
                   "writeStdin": "Codex wants to send input to a running command"}
_PERMISSIONS = [("Approve for this turn", "turn"), ("Approve for this session", "session"), ("Deny", "decline")]
MCP_APPROVAL_PREFIX = "mcp_tool_call_approval"
_MCP = [("Allow", "accept"), ("Allow for this session", "acceptForSession"), ("Cancel", "cancel")]
_REMEMBER = "Allow and don't ask me again"  # writes the owner's Codex config: never offered
_APPROVAL_TITLES = {"mcp_tool_call": "Codex wants to use an MCP tool",
                    "browser_auth": "An MCP server wants to sign in through your browser",
                    "tool_suggestion": "Codex suggests an MCP tool"}
_MAX_PAGES = 4  # Question.questions holds at most four pages
_NUMBERS = {"integer": "int", "number": "float"}


class Unserved(Exception):
    """A server request the office doesn't turn into a card; it gets a JSON-RPC error."""


@dataclass
class Card:
    """A Codex server request as a question card, and the reply each answer makes."""

    kind: str  # command | file_change | permissions | mcp_tool | question | elicitation
    question: Question
    call_id: str  # the tool part a decision is written on: the item's id, else a request part of its own
    replies: Callable[[Any], tuple[dict[str, Any], str]]
    secret: frozenset[str] = frozenset()  # headers of pages whose answers are stored as [secret]

    def reply(self, answer: Any) -> tuple[dict[str, Any], str]:
        """The JSON-RPC result for ``answer`` (as ``check_answer`` returned it), and the decision's variant name."""
        return self.replies(answer)


def _choice(options: list[tuple[str, str]], result: Callable[[str], dict[str, Any]]):
    mapping = dict(options)
    return lambda answer: (result(mapping[answer]), mapping[answer])


def _offered(available: list[Any] | None, options: list[tuple[str, str]]) -> list[tuple[str, str]]:
    # Persistent decisions are objects (amendments) and write the owner's Codex config: never offered.
    if available is None:
        return options
    names = {d for d in available if isinstance(d, str)}
    return [(label, d) for label, d in options if d in names]


def _with_reason(text: str, params: dict[str, Any]) -> str:
    return f"{text}\n{params['reason']}" if params.get("reason") else text


def _pruned(value: Any) -> Any:
    """``value`` without its null entries, at any depth: Codex sends every field it could have asked for."""
    if isinstance(value, dict):
        return {k: v for k, v in ((k, _pruned(v)) for k, v in value.items()) if v is not None and v != {}}
    return value


def _label(options: list[tuple[str, str]], decision: str) -> str:
    return next(label for label, d in options if d == decision)


def _typed(spec: dict[str, Any], value: Any) -> Any:
    """A typed form answer as the elicitation's schema wants it."""
    kind = spec.get("type")
    if kind == "boolean":
        return value == "Yes"
    if kind in _NUMBERS:
        return int(value) if kind == "integer" else float(value)
    return value


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

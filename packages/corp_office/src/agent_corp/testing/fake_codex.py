"""A scripted stand-in for ``codex app-server --listen stdio://``, for office tests and the fake-Codex e2e.

    python -I -m agent_corp.testing.fake_codex (--script s.json | --scenario e2e) [--log rpc.jsonl] [ignored args]

A script is ``{"thread": {"id", "model"}, "account": {...} | null, "initialize_error": {...}, "initialize_delay":
seconds, "resume_error": {...}, "stderr": "...", "turns": [[step, ...], ...]}``. Each ``turn/start`` that starts a turn
takes the next list of steps (an unscripted turn just completes). The count is kept next to ``--log``, so a restarted
fake goes on with the next turn. A step is one of:

- ``{"notify": method, "params": {...}}`` sends a notification;
- ``{"request": method, "params": {...}, "id": n, "wait": bool}`` sends a server request, waiting for the reply when
  ``wait``;
- ``{"wait_reply": n}`` waits for the reply to request ``n``; ``{"resolve": n}`` sends ``serverRequest/resolved``;
- ``{"sleep": seconds}``; ``{"exit": code}`` dies at once; ``{"end": "completed" | "failed", "error": {...}}``;
- ``{"spawn": seconds}`` starts ``sleep <seconds>`` in the fake's process group, as a command Codex runs would be,
  and logs its pid as ``{"dir": "spawn", "pid": n}``.

``"{thread}"``, ``"{turn}"`` and ``"{cwd}"`` in params are filled in. ``turn/start`` during a turn is a steer and
answers with the running turn. ``turn/interrupt`` stops the steps, resolves the requests still waiting, and completes
the turn ``interrupted``. Every message read or written is appended to ``--log`` as ``{"dir": "in"|"out", "msg"}``.
Stdin EOF exits 0. The builders below make steps whose messages match the pinned Codex schema.
"""

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

THREAD = {"id": "thr_fake", "model": "gpt-fake-codex"}


def fill(value: Any, turn: str, cwd: str, thread: str = THREAD["id"]) -> Any:
    """``value`` with ``{thread}``, ``{turn}`` and ``{cwd}`` filled in every string."""
    if isinstance(value, str):
        return value.replace("{thread}", thread).replace("{turn}", turn).replace("{cwd}", cwd)
    if isinstance(value, dict):
        return {k: fill(v, turn, cwd, thread) for k, v in value.items()}
    if isinstance(value, list):
        return [fill(v, turn, cwd, thread) for v in value]
    return value


# --- step builders: messages shaped as the pinned schema says --------------------------------

def _item(event: str, item: dict[str, Any]) -> dict[str, Any]:
    at = "startedAtMs" if event == "item/started" else "completedAtMs"
    return {"notify": event, "params": {"item": item, "threadId": "{thread}", "turnId": "{turn}", at: 0}}


def agent_message_delta(item_id: str, delta: str) -> dict[str, Any]:
    return {"notify": "item/agentMessage/delta",
            "params": {"threadId": "{thread}", "turnId": "{turn}", "itemId": item_id, "delta": delta}}


def agent_message(item_id: str, text: str) -> list[dict[str, Any]]:
    """An agent message streamed in two deltas, then completed."""
    half = len(text) // 2
    item = {"type": "agentMessage", "id": item_id, "text": text}
    return [_item("item/started", {**item, "text": ""}), agent_message_delta(item_id, text[:half]),
            agent_message_delta(item_id, text[half:]), _item("item/completed", item)]


def command(item_id: str, cmd: str, *, status: str = "completed", exit_code: int | None = 0,
            output: str | None = "") -> list[dict[str, Any]]:
    base = {"type": "commandExecution", "id": item_id, "command": cmd, "cwd": "{cwd}", "processId": None,
            "commandActions": [], "aggregatedOutput": None, "exitCode": None, "durationMs": None}
    done = {**base, "status": status, "aggregatedOutput": output, "exitCode": exit_code, "durationMs": 5}
    return [_item("item/started", {**base, "status": "inProgress"}), _item("item/completed", done)]


def command_started(item_id: str, cmd: str) -> dict[str, Any]:
    return command(item_id, cmd)[0]


def command_approval(request_id: int, item_id: str, cmd: str, *, wait: bool = True) -> dict[str, Any]:
    return {"request": "item/commandExecution/requestApproval", "id": request_id, "wait": wait, "params": {
        "threadId": "{thread}", "turnId": "{turn}", "itemId": item_id, "startedAtMs": 0, "command": cmd,
        "cwd": "{cwd}", "availableDecisions": ["accept", "acceptForSession", "decline", "cancel"]}}


def file_change(item_id: str, path: str, diff: str, *, kind: str = "add",
                status: str = "completed") -> list[dict[str, Any]]:
    """A file change. As in Codex, ``diff`` is the whole content for ``add`` and ``delete``, and a unified diff only
    for ``update``."""
    change = {"path": path, "kind": {"type": kind, **({"move_path": None} if kind == "update" else {})}, "diff": diff}
    item = {"type": "fileChange", "id": item_id, "changes": [change]}
    return [_item("item/started", {**item, "status": "inProgress"}), _item("item/completed", {**item, "status": status})]


def file_change_approval(request_id: int, item_id: str, *, wait: bool = True) -> dict[str, Any]:
    return {"request": "item/fileChange/requestApproval", "id": request_id, "wait": wait, "params": {
        "threadId": "{thread}", "turnId": "{turn}", "itemId": item_id, "startedAtMs": 0, "reason": None,
        "grantRoot": None}}


def permissions_approval(request_id: int, item_id: str, *, wait: bool = True) -> dict[str, Any]:
    return {"request": "item/permissions/requestApproval", "id": request_id, "wait": wait, "params": {
        "threadId": "{thread}", "turnId": "{turn}", "itemId": item_id, "startedAtMs": 0, "cwd": "{cwd}",
        "reason": "needs the network", "permissions": {"network": {"enabled": True}, "fileSystem": None}}}


def question(qid: str, header: str, text: str, *, options: list[str] | None = None, other: bool = False,
             secret: bool = False) -> dict[str, Any]:
    return {"id": qid, "header": header, "question": text, "isOther": other, "isSecret": secret,
            "options": [{"label": o, "description": ""} for o in options] if options is not None else None}


def user_input(request_id: int, item_id: str, questions: list[dict[str, Any]], *, wait: bool = True) -> dict[str, Any]:
    return {"request": "item/tool/requestUserInput", "id": request_id, "wait": wait, "params": {
        "threadId": "{thread}", "turnId": "{turn}", "itemId": item_id, "questions": questions, "isBlocking": True}}


def mcp_approval(request_id: int, server: str, tool: str, *, session_option: bool = True,
                 wait: bool = True) -> dict[str, Any]:
    """An MCP tool approval in its elicitation form (``_meta.codex_approval_kind``)."""
    meta = {"codex_approval_kind": "mcp_tool_call", "tool_name": tool, **({"persist": "session"} if session_option else {})}
    return {"request": "mcpServer/elicitation/request", "id": request_id, "wait": wait, "params": {
        "serverName": server, "threadId": "{thread}", "turnId": "{turn}", "mode": "form", "_meta": meta,
        "message": f"Allow {server} to run {tool}?", "requestedSchema": {"type": "object", "properties": {}}}}


def mcp_approval_question(request_id: int, item_id: str, server: str, tool: str, *, wait: bool = True) -> dict[str, Any]:
    """An MCP tool approval in its requestUserInput form."""
    q = question("mcp_tool_call_approval_1", "Approve app tool call?", f"Allow {server} to run {tool}?",
                 options=["Allow", "Allow for this session", "Allow and don't ask me again", "Cancel"])
    return user_input(request_id, item_id, [q], wait=wait)


def network_approval(request_id: int, item_id: str, host: str, *, protocol: str = "https",
                     wait: bool = True) -> dict[str, Any]:
    """A managed-network approval: a command approval with no command or cwd, only the host."""
    step = command_approval(request_id, item_id, "", wait=wait)
    step["params"].update(command=None, cwd=None, networkApprovalContext={"host": host, "protocol": protocol})
    return step


def url_elicitation(request_id: int, server: str, message: str, url: str, *, wait: bool = True) -> dict[str, Any]:
    """An MCP server's URL elicitation, with no turn (``turnId`` is nullable)."""
    return {"request": "mcpServer/elicitation/request", "id": request_id, "wait": wait, "params": {
        "serverName": server, "threadId": "{thread}", "turnId": None, "mode": "url", "elicitationId": f"e{request_id}",
        "message": message, "url": url}}


def form_elicitation(request_id: int, server: str, message: str, properties: dict[str, Any], *,
                     wait: bool = True) -> dict[str, Any]:
    """An MCP server's form elicitation; ``properties`` is its requested schema's."""
    return {"request": "mcpServer/elicitation/request", "id": request_id, "wait": wait, "params": {
        "serverName": server, "threadId": "{thread}", "turnId": "{turn}", "mode": "form", "message": message,
        "requestedSchema": {"type": "object", "properties": properties}}}


def token_usage(input_tokens: int, cached: int, output: int) -> dict[str, Any]:
    total = {"totalTokens": input_tokens + output, "inputTokens": input_tokens, "cachedInputTokens": cached,
             "cacheWriteInputTokens": 0, "outputTokens": output, "reasoningOutputTokens": 0}
    return {"notify": "thread/tokenUsage/updated", "params": {"threadId": "{thread}", "turnId": "{turn}",
                                                             "tokenUsage": {"total": total, "last": total,
                                                                            "modelContextWindow": None}}}


def error(message: str, *, will_retry: bool) -> dict[str, Any]:
    return {"notify": "error", "params": {"threadId": "{thread}", "turnId": "{turn}", "willRetry": will_retry,
                                          "error": {"message": message, "codexErrorInfo": None}}}


def thread_closed() -> dict[str, Any]:
    return {"notify": "thread/closed", "params": {"threadId": "{thread}"}}


def e2e() -> dict[str, Any]:
    """The tmux e2e's script: two cards at once, a secret question, a long command to interrupt, a crash, then quiet
    turns (restarts and continuing go on from the turn count)."""
    return {"thread": {"id": "thr_e2e", "model": "gpt-fake-codex"}, "turns": [
        [*agent_message("m1", "I'll create hello.txt."), command_started("c1", "touch hello.txt"),
         command_approval(1, "c1", "touch hello.txt", wait=False), permissions_approval(2, "p1", wait=False),
         {"wait_reply": 1}, command("c1", "touch hello.txt")[1], {"wait_reply": 2},
         *file_change("f1", "{cwd}/hello.txt", "hello\n"), token_usage(1200, 800, 90), *agent_message("m2", "Done.")],
        [user_input(3, "u1", [question("token", "Token", "Paste the deploy token", secret=True)]),
         *agent_message("m3", "Thanks, got it.")],
        [command_started("c2", "sleep 30"), {"sleep": 30}],
        [*agent_message("m4", "Working on it…")[:2], {"spawn": 300}, {"exit": 1}],
        *[[*agent_message(f"q{n}", f"Quiet turn {n}.")] for n in range(5, 12)],
    ]}

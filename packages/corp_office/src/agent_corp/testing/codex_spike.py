"""Owner-run spike: the installed Codex app-server against the claims step 1 of the Codex harness rests on.

Run it from a plain terminal (not under a sandbox-exec launcher, which can't nest), in a checkout:

    uv run python -I -m agent_corp.testing.codex_spike --out packages/corp_office/tests/harness/fixtures/codex

It needs a signed-in ``codex`` on PATH, spends a few small turns of the owner's Codex login, and works only in a
scratch git repo under a temp folder, removed when it is done. Under ``--out`` it writes ``schema/`` (the pinned
protocol), ``sessions/<scenario>.jsonl`` (requests, answers and the notifications the office reads, both ways,
scrubbed) and ``spike.json`` (each check's result), and it prints the checklist. ``--scenario NAME`` runs one of S3's
scenarios again and merges it into ``spike.json``. It never reads or prints a token. It uses only the stdlib, so it
runs before the office's Codex code exists.
"""

import argparse
import getpass
import itertools
import json
import os
import queue
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

SCHEMA_FILES = ("ServerRequest.json", "ServerNotification.json", "ClientRequest.json",
                "CommandExecutionRequestApprovalResponse.json", "FileChangeRequestApprovalResponse.json",
                "PermissionsRequestApprovalResponse.json", "ToolRequestUserInputResponse.json",
                "McpServerElicitationRequestResponse.json")
_EMAIL_KEYS = {"email"}
KEPT_NOTIFICATIONS = ("turn/", "item/", "serverRequest/resolved", "error", "thread/started", "thread/closed",
                      "thread/status/changed", "thread/tokenUsage/updated")
"""Notification methods a recording keeps: the ones the office reads. Others (MCP server startup, config warnings,
rate limits, account updates) can name the owner's servers, plugins and hosts."""


class SpikeError(Exception):
    """The app-server answered a request with an error, or never answered."""


def scrub(value: Any, replacements: dict[str, str]) -> Any:
    """``value`` with each key of ``replacements`` replaced in every string, longest first, and every ``email`` field
    set to ``owner@example.com``."""
    order = sorted(replacements, key=len, reverse=True)

    def text(s: str) -> str:
        for old in order:
            s = s.replace(old, replacements[old])
        return s

    def walk(v: Any, key: str | None = None) -> Any:
        if key in _EMAIL_KEYS and isinstance(v, str):
            return "owner@example.com"
        if isinstance(v, str):
            return text(v)
        if isinstance(v, dict):
            return {k: walk(x, k) for k, x in v.items()}
        if isinstance(v, list):
            return [walk(x) for x in v]
        return v

    return walk(value)


def kept(msg: dict[str, Any]) -> bool:
    """Whether a recording keeps ``msg``: every request and answer, and the notifications the office reads."""
    method = msg.get("method")
    return method is None or "id" in msg or method.startswith(KEPT_NOTIFICATIONS)


def pin_schema(generated: Path, out: Path, *, version: str) -> None:
    """Copy the bundles the office's tests read (requests, notifications, and the replies to served requests) from
    ``generated`` into ``out``, with the Codex version."""
    out.mkdir(parents=True, exist_ok=True)
    for name in SCHEMA_FILES:
        shutil.copyfile(generated / name, out / name)
    (out / "VERSION").write_text(version + "\n")

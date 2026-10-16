"""One ``codex app-server --listen stdio://``: its command, owner-load params, process group, and worker record."""

import shutil
from typing import Any

from agent_corp.protocol.models import HarnessPolicy

APP_SERVER_ARGS = ("app-server", "--listen", "stdio://")
CLOSE_GRACE = 5.0
"""Seconds an app-server has to exit after stdin closes, before its group is killed."""
START_TIMEOUT = 30.0
_TAIL_BYTES = 4000


class CodexStartError(Exception):
    """The app-server didn't start or refused the handshake; ``tail`` is the end of its stderr."""

    def __init__(self, message: str, tail: str = "") -> None:
        super().__init__(message)
        self.tail = tail


class CodexMissing(CodexStartError):
    """No ``codex`` on the office's PATH."""


class CodexSignedOut(CodexStartError):
    """Codex runs but has no account signed in."""


def codex_command(env: dict[str, str]) -> list[str]:
    """``codex app-server --listen stdio://`` with ``codex`` found on ``env``'s PATH (the office's own)."""
    found = shutil.which("codex", path=env.get("PATH"))
    if found is None:
        raise CodexMissing("Codex isn't installed where the office can find it (on its PATH). Install it "
                           "(npm install -g @openai/codex), sign in with `codex login`, then run `ac doctor`.")
    return [found, *APP_SERVER_ARGS]


def owner_load(cwd: str, policy: HarnessPolicy | None) -> dict[str, Any]:
    """The params of every owner load (thread/start, thread/resume): the person's sandbox and network, and approvals
    that always come to the office's cards whatever the owner's config.toml says.

    ``config`` values are nested objects, never dotted keys: Codex splits override keys on every dot.
    """
    return {"cwd": cwd, "sandbox": policy.sandbox if policy else "read-only", "approvalPolicy": "on-request",
            "approvalsReviewer": "user",
            "config": {"sandbox_workspace_write": {"network_access": bool(policy and policy.network)}}}

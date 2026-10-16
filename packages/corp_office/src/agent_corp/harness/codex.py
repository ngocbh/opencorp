"""One ``codex app-server --listen stdio://``: its command, owner-load params, process group, and worker record."""

import logging
import os
import shutil
import subprocess
import threading
import time
from collections.abc import Callable, Mapping
from importlib.metadata import version
from pathlib import Path
from typing import Any

from agent_corp.harness.rpc import JsonRpc, RpcClosed, RpcError
from agent_corp.protocol.models import HarnessPolicy
from agent_corp.store import Store
from agent_corp.worker.reaper import kill_group, start_time

log = logging.getLogger(__name__)

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


def codex_command(env: Mapping[str, str], environ: Mapping[str, str] = os.environ) -> list[str]:
    """``codex app-server --listen stdio://`` with ``codex`` found on ``env``'s PATH (the office's own).

    ``AGENT_CORP_CODEX_BIN`` in the office's ``environ`` names another binary (a path, or a name on that PATH).
    """
    binary = environ.get("AGENT_CORP_CODEX_BIN") or "codex"
    found = shutil.which(binary, path=env.get("PATH"))
    if found is None:
        name = "Codex" if binary == "codex" else f"Codex ({binary}, from AGENT_CORP_CODEX_BIN)"
        raise CodexMissing(f"{name} isn't installed where the office can find it (on its PATH). Install it "
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


class CodexProcess:
    """One app-server in its own process group, recorded in the store's workers under ``key`` for ``reap``.

    ``on_exit(process)`` runs once when its stdout ends, whoever ended it.
    """

    def __init__(self, store: Store, key: str, *, command: list[str], cwd: str, env: dict[str, str], log: Path,
                 on_notification: Callable[[str, dict], None], on_request: Callable[[Any, str, dict], None],
                 on_exit: Callable[["CodexProcess"], None]) -> None:
        self.store, self.key, self.command, self.cwd, self.log = store, key, command, cwd, log
        # Codex finds its config and sign-in through CODEX_HOME when the owner sets one, and ~/.codex otherwise.
        home = os.environ.get("CODEX_HOME")
        self.env = {**env, "CODEX_HOME": home} if home else dict(env)
        self._on_notification, self._on_request, self._on_exit = on_notification, on_request, on_exit
        self.proc: subprocess.Popen[bytes] | None = None
        self.rpc: JsonRpc | None = None
        self.closing = False
        self._lock = threading.Lock()  # a kill (office stop) either comes before the spawn or sees its process
        self._recorded = False
        self._killed = False

    @property
    def pid(self) -> int:
        return self.proc.pid

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def start(self) -> dict[str, Any]:
        """Spawn, record, initialize with ``experimentalApi``, and check the sign-in; return initialize's result.

        Raises ``CodexStartError`` (or ``CodexSignedOut``) with the stderr tail; nothing is left running or recorded.
        A process already killed never spawns.
        """
        self.log.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            if self.closing:
                raise CodexStartError("Codex was stopped before it started.")
            try:
                with open(self.log, "ab") as err:
                    self.proc = subprocess.Popen(self.command, cwd=self.cwd, env=self.env, stdin=subprocess.PIPE,
                                                 stdout=subprocess.PIPE, stderr=err, start_new_session=True)
            except OSError as exc:
                raise CodexStartError(f"Codex couldn't start: {exc}") from exc
            self.store.record_worker(self.key, pid=self.proc.pid, pgid=self.proc.pid,
                                     start_time=start_time(self.proc.pid) or time.time())
            self._recorded = True
        self.rpc = JsonRpc(self.proc.stdin, self.proc.stdout, on_notification=self._on_notification,
                           on_request=self._on_request, on_closed=self._closed)
        self.rpc.start()
        try:
            result = self.rpc.request("initialize", {
                "clientInfo": {"name": "agent_corp", "title": "AgentCorp", "version": version("agent-corp")},
                "capabilities": {"experimentalApi": True}}, timeout=START_TIMEOUT)
            self.rpc.notify("initialized")
            account = self.rpc.request("account/read", {"refreshToken": False}, timeout=START_TIMEOUT)
        except (RpcError, RpcClosed, TimeoutError) as exc:
            self.kill()
            raise CodexStartError(f"Codex didn't start: {exc}", self.stderr_tail()) from exc
        if account.get("account") is None and account.get("requiresOpenaiAuth"):
            self.kill()
            raise CodexSignedOut("Codex is signed out. Run `codex login` in a terminal, then send your message again.")
        return result

    def close(self, grace: float = CLOSE_GRACE) -> None:
        """Close stdin, give it ``grace`` seconds, kill the group (its command children too), forget the record."""
        self.closing = True
        if self.proc is not None:
            try:
                self.proc.stdin.close()
            except OSError:
                pass
            try:
                self.proc.wait(grace)
            except subprocess.TimeoutExpired:
                pass
        self.kill()

    def kill(self) -> None:
        """Kill the group now (the app-server may leave command children, #57), and forget its record.

        Safe from any thread, more than once, and before ``start``: a process killed first never spawns.
        """
        with self._lock:
            self.closing = True
            proc, recorded, self._recorded = self.proc, self._recorded, False
            # Only the first kill signals the group: once it is gone its id can belong to another group.
            signal_group, self._killed = proc is not None and not self._killed, True
        if signal_group:
            kill_group(proc.pid)
            try:
                proc.wait(5)
            except subprocess.TimeoutExpired:
                log.warning("codex app-server %s outlived SIGKILL", proc.pid)
        if recorded:  # only its own record: a later app-server of the same session has the same key
            self.store.remove_worker(self.key, pid=proc.pid)

    def stderr_tail(self) -> str:
        """The end of the app-server's stderr, for an error part."""
        try:
            with open(self.log, "rb") as f:
                f.seek(max(0, os.path.getsize(self.log) - _TAIL_BYTES))
                return f.read().decode(errors="replace").strip()
        except OSError:
            return ""

    def _closed(self) -> None:
        if self.proc is not None:
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                pass
        self._on_exit(self)

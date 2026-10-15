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


class Recorder:
    """Appends each message ``kept`` keeps, scrubbed, to a JSONL file as ``{"dir": "in" | "out", "msg": ...}``."""

    def __init__(self, path: Path, replacements: dict[str, str]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("")
        self.path, self.replacements = path, replacements
        self._lock = threading.Lock()

    def write(self, direction: str, msg: dict[str, Any]) -> None:
        if not kept(msg):
            return
        line = json.dumps({"dir": direction, "msg": scrub(msg, self.replacements)})
        with self._lock, self.path.open("a") as f:
            f.write(line + "\n")


class AppServer:
    """One stdio JSON-RPC server (``codex app-server``) in its own process group, with ``env`` (the spike's own when
    None); ``recorder`` keeps its messages."""

    def __init__(self, command: list[str], cwd: Path, recorder: Recorder, env: dict[str, str] | None = None) -> None:
        self.proc = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True, bufsize=1, start_new_session=True)
        self.recorder = recorder
        self._ids = itertools.count(1)
        self._answers: dict[Any, dict[str, Any]] = {}
        self._answered = threading.Condition()
        self._inbox: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self.seen: list[dict[str, Any]] = []  # notifications and requests taken from the inbox
        threading.Thread(target=self._read, daemon=True).start()

    def __enter__(self) -> "AppServer":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _read(self) -> None:
        for line in self.proc.stdout:
            msg = json.loads(line)
            self.recorder.write("in", msg)
            if "id" in msg and "method" not in msg:
                with self._answered:
                    self._answers[msg["id"]] = msg
                    self._answered.notify_all()
            else:
                self._inbox.put(msg)
        self._inbox.put(None)

    def send(self, msg: dict[str, Any]) -> None:
        self.recorder.write("out", msg)
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def request_raw(self, method: str, params: dict[str, Any] | None = None, timeout: float = 120) -> dict[str, Any]:
        """Send a request; return its whole answer (``result`` or ``error``)."""
        request_id = next(self._ids)
        self.send({"id": request_id, "method": method, "params": params or {}})
        with self._answered:
            if not self._answered.wait_for(lambda: request_id in self._answers, timeout):
                raise SpikeError(f"{method} got no answer in {timeout:.0f}s")
            return self._answers.pop(request_id)

    def request(self, method: str, params: dict[str, Any] | None = None, timeout: float = 120) -> Any:
        answer = self.request_raw(method, params, timeout)
        if "error" in answer:
            raise SpikeError(f"{method}: {answer['error']}")
        return answer.get("result")

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        self.send({"method": method, **({"params": params} if params is not None else {})})

    def reply(self, request_id: Any, result: dict[str, Any]) -> None:
        self.send({"id": request_id, "result": result})

    def next(self, timeout: float = 180) -> dict[str, Any]:
        """The next notification or server request."""
        msg = self._inbox.get(timeout=timeout)
        if msg is None:
            raise SpikeError("the app-server closed its stdout")
        self.seen.append(msg)
        return msg

    def wait(self, method: str, timeout: float = 180,
             where: Callable[[dict[str, Any]], bool] = lambda m: True) -> dict[str, Any]:
        """The first message (seen already, or next) with ``method`` that ``where`` accepts."""
        for msg in self.seen:
            if msg.get("method") == method and where(msg):
                return msg
        deadline = time.monotonic() + timeout
        while True:
            msg = self.next(max(0.1, deadline - time.monotonic()))
            if msg.get("method") == method and where(msg):
                return msg

    def close(self, timeout: float = 10) -> float:
        """Close stdin and wait; return the seconds until exit (the group is killed after ``timeout``)."""
        start = time.monotonic()
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(timeout)
        except subprocess.TimeoutExpired:
            os.killpg(self.proc.pid, signal.SIGKILL)
            self.proc.wait()
        return time.monotonic() - start


INHERITED_ENV = ("PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "TZ")
"""``agent_corp.worker.spawn.INHERITED_ENV``, repeated: the spike imports nothing from the office."""
_RELEVANT = re.compile(r"PROXY|SSL|CERT|CA_BUNDLE|CODEX|OPENAI|NODE|XDG", re.I)


def office_env(environ: dict[str, str]) -> dict[str, str]:
    """The environment the office gives an app-server: ``INHERITED_ENV`` and ``LC_*`` (not ``LC_TERMINAL*``), as
    ``daemon_env`` and then ``worker_env`` narrow it."""
    return {k: v for k, v in environ.items()
            if k in INHERITED_ENV or (k.startswith("LC_") and not k.startswith("LC_TERMINAL"))}


def missing_names(full: dict[str, str], narrow: dict[str, str]) -> dict[str, Any]:
    """The names (never the values) of variables ``full`` has and ``narrow`` lacks that could matter to Codex
    (proxies, certificates, Codex, OpenAI, Node), and how many others it lacks."""
    gone = [k for k in full if k not in narrow]
    relevant = sorted(k for k in gone if _RELEVANT.search(k))
    return {"relevant": relevant, "others": len(gone) - len(relevant)}


class Check:
    """One claim the spike checks, and the PRs that wait on it."""

    def __init__(self, id: str, name: str, claim: str, gates: str) -> None:
        self.id, self.name, self.claim, self.gates = id, name, claim, gates


CHECKS = [
    Check("S1", "launch", "`codex app-server --listen stdio://` starts through the installed launcher and initializes "
          "with experimentalApi; `codex login status` and account/read say signed in", "PR 4, PR 8, PR 11"),
    Check("S2", "owner-load", "an owner load (sandbox, network config, on-request, reviewer user) works on your "
          "config.toml and comes back with approvalPolicy on-request and approvalsReviewer user",
          "PR 5 (Step 22), PR 6"),
    Check("S3", "sessions", "golden sessions recorded, each scenario with its own result: plain, command approve and "
          "decline, file change, interrupt with a pending approval, steer (turn/start on a busy thread answers the "
          "running turn), resume, and whether a thread that never ran a turn resumes; whether any auto-review showed "
          "up. ok when the four core scenarios are", "PR 5, PR 6, PR 7, PR 8, PR 10 (each by scenario; see Step 3)"),
    Check("S4", "service-read", "thread/read on a second app-server while a turn runs in the first (step 2 only)", "none"),
    Check("S5", "writer-lock", "thread/resume of a thread loaded in another app-server: Codex refuses, and with what",
          "PR 8"),
    Check("S6", "eof", "stdin EOF during a command: seconds until exit, and whether the command outlives it", "PR 8"),
    Check("S7", "office-env", "in the environment the office gives an app-server (PATH, HOME, USER, LOGNAME, LANG, "
          "TMPDIR, TZ, LC_*): account/read with refreshToken says signed in, and a plain turn completes; the names of "
          "what that environment drops that could matter (proxies, certificates, CODEX_HOME)", "PR 6"),
    Check("S8", "schema", "the pinned schema (generate-json-schema --experimental)", "PR 4, PR 5"),
]


def owner_load(cwd: str, sandbox: str = "read-only", *, network: bool = False) -> dict[str, Any]:
    """The owner-load params the office will pass on thread/start and thread/resume."""
    return {"cwd": cwd, "sandbox": sandbox, "approvalPolicy": "on-request", "approvalsReviewer": "user",
            "config": {"sandbox_workspace_write": {"network_access": network}}}


def checklist(results: dict[str, dict[str, Any]]) -> str:
    """One line per check: ``ok``/``FAIL``, its id and name, the claim, and the recorded detail."""
    return "".join(f"{'ok  ' if results[c.id]['ok'] else 'FAIL'} {c.id} {c.name}: {c.claim} -> "
                   f"{json.dumps(results[c.id].get('detail'))}\n" for c in CHECKS)


def _text(text: str) -> list[dict[str, Any]]:
    return [{"type": "text", "text": text, "text_elements": []}]


def _decision(method: str, choice: str) -> dict[str, Any]:
    """The reply that makes ``choice`` (accept or decline) on any approval kind."""
    if method in ("item/commandExecution/requestApproval", "item/fileChange/requestApproval"):
        return {"decision": choice}
    if method == "item/permissions/requestApproval":
        return {"permissions": {}, "scope": "turn"}
    if method == "mcpServer/elicitation/request":
        return {"action": "cancel"}
    return {"answers": {}}


class Spike:
    """The checks, in order, against one ``codex`` binary, in a scratch repo under a temp folder that ``run``
    removes; outputs go under ``out``."""

    def __init__(self, codex: str, out: Path) -> None:
        self.codex, self.out = codex, out
        out.mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix="ac-codex-spike-"))
        self.ws = self.root / "ws"
        self.ws.mkdir()
        # The owner's git config may sign commits or run hooks; a scratch repo needs neither.
        git = ["git", "-c", "user.name=spike", "-c", "user.email=spike@example.com", "-c", "commit.gpgsign=false",
               "-c", f"core.hooksPath={os.devnull}"]
        subprocess.run([*git, "init", "-q"], cwd=self.ws, check=True)
        (self.ws / "README.md").write_text("Scratch repo for the agent-corp Codex spike.\n")
        subprocess.run([*git, "add", "-A"], cwd=self.ws, check=True)
        subprocess.run([*git, "commit", "-qm", "init"], cwd=self.ws, check=True)
        home, user = str(Path.home()), getpass.getuser()
        self.replacements = {str(self.ws): "/work/spike/ws", os.path.realpath(self.ws): "/work/spike/ws",
                             str(self.root): "/work/spike", os.path.realpath(self.root): "/work/spike",
                             home: "/home/owner", os.path.realpath(home): "/home/owner"}
        if len(user) >= 3:
            self.replacements[user] = "owner"

    def server(self, name: str, env: dict[str, str] | None = None) -> AppServer:
        server = AppServer([self.codex, "app-server", "--listen", "stdio://"], self.ws,
                           Recorder(self.out / "sessions" / f"{name}.jsonl", self.replacements), env)
        server.request("initialize", {"clientInfo": {"name": "agent_corp_spike", "title": "AgentCorp spike",
                                                     "version": "0"}, "capabilities": {"experimentalApi": True}})
        server.notify("initialized")
        return server

    def start(self, server: AppServer, sandbox: str = "read-only") -> str:
        return server.request("thread/start", owner_load(str(self.ws), sandbox))["thread"]["id"]

    def turn(self, server: AppServer, thread: str, text: str, decide: str | None = None) -> dict[str, Any]:
        """Run a turn, answering each approval with ``decide``; return turn/completed, or the first request when
        ``decide`` is None."""
        server.request("turn/start", {"threadId": thread, "input": _text(text)})
        while True:
            msg = server.next()
            if msg.get("method") == "turn/completed":
                return msg
            if "id" in msg:
                if decide is None:
                    return msg
                server.reply(msg["id"], _decision(msg["method"], decide))

    def run(self) -> dict[str, dict[str, Any]]:
        """Every check; ``spike.json`` gets each one's result."""
        results: dict[str, dict[str, Any]] = {}
        thread = None
        try:
            for check in CHECKS:
                try:
                    if check.id == "S3":
                        detail, thread = self.sessions()
                    elif check.id in ("S4", "S5") and thread is None:
                        raise SpikeError("needs the thread of S3's plain scenario")
                    else:
                        detail = getattr(self, check.name.replace("-", "_"))(thread)
                    ok = bool(detail.pop("ok", True))
                except Exception as exc:  # one failed check mustn't hide the others
                    ok, detail = False, {"error": scrub(str(exc), self.replacements)}
                results[check.id] = {"ok": ok, "detail": detail}
        finally:
            shutil.rmtree(self.root, ignore_errors=True)
        self._write(results)
        return results

    def _write(self, results: dict[str, dict[str, Any]]) -> None:
        (self.out / "spike.json").write_text(json.dumps(results, indent=2) + "\n")


def main(argv: list[str] | None = None) -> int:
    """Run the spike and print its checklist; exit 1 when a check that gates a PR fails, 2 without ``codex``."""
    parser = argparse.ArgumentParser(prog="codex_spike", description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--codex", default="codex", help="the codex binary (default: codex on PATH)")
    args = parser.parse_args(argv)
    codex = shutil.which(args.codex)
    if codex is None:
        print(f"{args.codex} is not on PATH")
        return 2
    results = Spike(codex, args.out).run()
    print(checklist(results), end="")
    gating = [c.id for c in CHECKS if c.gates != "none"]
    return 0 if all(results[i]["ok"] for i in gating) else 1


if __name__ == "__main__":
    raise SystemExit(main())

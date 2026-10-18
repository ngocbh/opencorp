"""Owner-run spike: the installed Codex app-server against the claims the office's Codex harness rests on.

Run it from a plain terminal (not under a sandbox-exec launcher, which can't nest), in a checkout:

    uv run python -I -m agent_corp.testing.codex_spike --out packages/corp_office/tests/harness/fixtures/codex

It needs a signed-in ``codex`` (``--codex PATH`` picks the binary; the default is ``codex`` on PATH). For a Codex
installed beside another ``codex``, pass ``--codex <its path>`` and export the ``CODEX_HOME`` it uses; the office will
give its app-servers the same ``CODEX_HOME``.

It spends a few small turns of the owner's Codex login, and works only in a scratch git repo under a temp folder,
removed when it is done. The threads it starts stay in the owner's Codex history (``codex resume`` lists them). Under
``--out`` it writes ``schema/`` (the pinned protocol), ``sessions/<scenario>.jsonl`` (requests, answers and the
notifications the office reads, both ways, scrubbed) and ``spike.json`` (each check's result), and it prints the
checklist. ``--scenario NAME`` runs one of S3's scenarios (or the eof or office-env check) again and merges it into
``spike.json``. It never reads or prints a token. It uses only the stdlib, so it runs before the office's Codex code
exists.
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
import socket
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
# A letter-only top-level domain, so ``react@18.2.0`` and ``@openai/codex@0.130.0`` aren't taken for addresses.
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b")
_PROTOCOL_WORDS = {"user", "model", "status", "agent", "admin", "root", "codex", "owner", "thread", "turn", "item",
                   "text", "error", "local", "localhost", "server", "client", "default"}
"""Words the protocol itself uses. A user or host with one of these names stays unscrubbed, since replacing it would
rewrite protocol keys and values."""
KEPT_NOTIFICATIONS = ("turn/", "item/", "serverRequest/resolved", "error", "thread/started", "thread/closed",
                      "thread/status/changed", "thread/tokenUsage/updated")
"""Notification methods a recording keeps: the ones the office reads. Others (MCP server startup, config warnings,
rate limits, account updates) can name the owner's servers, plugins and hosts."""


class SpikeError(Exception):
    """The app-server answered a request with an error, or never answered."""


def scrub(value: Any, replacements: dict[str, str], words: dict[str, str] | None = None) -> Any:
    """``value`` with every email address set to ``owner@example.com``, each key of ``replacements`` replaced
    anywhere, and each key of ``words`` replaced where it stands alone (not inside a path or a longer name), longest
    first, in every string and dict key."""
    order = sorted(replacements, key=len, reverse=True)
    # A user name like ``dev`` must not turn ``/dev/null`` or ``dev-tools`` into something else.
    alone = [(re.compile(rf"(?<![\w/.-]){re.escape(w)}(?![\w/-])"), (words or {})[w])
             for w in sorted(words or {}, key=len, reverse=True)]

    def text(s: str) -> str:
        s = _EMAIL.sub("owner@example.com", s)
        for old in order:
            s = s.replace(old, replacements[old])
        for pattern, new in alone:
            s = pattern.sub(lambda _, new=new: new, s)
        return s

    def walk(v: Any, key: str | None = None) -> Any:
        if key in _EMAIL_KEYS and isinstance(v, str):
            return "owner@example.com"
        if isinstance(v, str):
            return text(v)
        if isinstance(v, dict):
            return {text(k): walk(x, k) for k, x in v.items()}
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


def _stream(msg: dict[str, Any]) -> tuple[Any, ...] | None:
    """The stream a streamed ``item/...`` delta belongs to (its method and every param but ``delta``, so reasoning's
    summary and content parts stay apart), or None for any other message."""
    params = msg.get("params")
    if not (str(msg.get("method")).startswith("item/") and isinstance(params, dict)
            and isinstance(params.get("delta"), str) and isinstance(params.get("itemId"), str)):
        return None
    return (msg["method"], *sorted((k, json.dumps(v)) for k, v in params.items() if k != "delta"))


def recut(text: Callable[[str], str], pieces: list[str]) -> list[str]:
    """``text`` of the joined ``pieces``, cut into as many pieces. A cut stays after the same text as before; one
    inside a name ``text`` replaces moves back to where the replacement first differs from the name."""
    joined = "".join(pieces)
    whole, cuts, end = text(joined), [0], 0
    for piece in pieces[:-1]:
        end += len(piece)
        cuts.append(max(cuts[-1], len(os.path.commonprefix([text(joined[:end]), whole]))))
    return [whole[a:b] for a, b in zip(cuts, [*cuts[1:], len(whole)])]


class Recorder:
    """Appends each message ``kept`` keeps, scrubbed, to a JSONL file as ``{"dir": "in" | "out", "msg": ...}``.

    A name can be split across an item's streamed deltas, where scrubbing each one alone would miss it. So from an
    item's first delta until it completes (or its turn does, or ``flush``), every message waits; then each stream's
    deltas are scrubbed as one text and cut again into as many deltas, and the messages are written in order."""

    def __init__(self, path: Path, replacements: dict[str, str], words: dict[str, str] | None = None) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("")
        self.path, self.replacements, self.words = path, replacements, words or {}
        self._lock = threading.Lock()
        self._held: list[tuple[str, dict[str, Any]]] = []
        self._open: set[tuple[str | None, str]] = set()  # (turnId, itemId) of each item still streaming

    def scrub(self, value: Any) -> Any:
        return scrub(value, self.replacements, self.words)

    def write(self, direction: str, msg: dict[str, Any]) -> None:
        if not kept(msg):
            return
        with self._lock:
            params = msg.get("params") or {}
            if _stream(msg):
                self._open.add((params.get("turnId"), params["itemId"]))
            if not self._open:
                self._append([(direction, self.scrub(msg))])
                return
            self._held.append((direction, msg))
            if msg.get("method") == "item/completed" and isinstance(params.get("item"), dict):
                self._open = {(t, i) for t, i in self._open if i != params["item"].get("id")}
            elif msg.get("method") == "turn/completed" and isinstance(params.get("turn"), dict):
                self._open = {(t, i) for t, i in self._open if t != params["turn"].get("id")}
            if not self._open:
                self._flush()

    def flush(self) -> None:
        """Write what waits on a stream that never completed."""
        with self._lock:
            self._open.clear()
            self._flush()

    def _flush(self) -> None:
        held, self._held = self._held, []
        streams: dict[tuple[Any, ...], list[int]] = {}
        for n, (_, msg) in enumerate(held):
            if (stream := _stream(msg)) is not None:
                streams.setdefault(stream, []).append(n)
        out = [(direction, self.scrub(msg)) for direction, msg in held]
        for at in streams.values():
            pieces = recut(self.scrub, [held[n][1]["params"]["delta"] for n in at])
            for n, piece in zip(at, pieces):
                out[n][1]["params"]["delta"] = piece
        self._append(out)

    def _append(self, entries: list[tuple[str, dict[str, Any]]]) -> None:
        """Write already scrubbed ``(direction, msg)`` pairs."""
        lines = "".join(json.dumps({"dir": direction, "msg": msg}) + "\n" for direction, msg in entries)
        if lines:
            with self.path.open("a") as f:
                f.write(lines)


class AppServer:
    """One stdio JSON-RPC server (``codex app-server``) in its own process group, with ``env`` (the spike's own when
    None); ``recorder`` keeps its messages, and ``stderr`` (when given) gets its stderr, whose last lines go into the
    errors it raises."""

    def __init__(self, command: list[str], cwd: Path, recorder: Recorder, env: dict[str, str] | None = None,
                 stderr: Path | None = None) -> None:
        self.stderr = stderr
        err = stderr.open("w") if stderr else subprocess.DEVNULL
        try:
            self.proc = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                         stderr=err, text=True, bufsize=1, start_new_session=True)
        finally:
            if stderr:
                err.close()
        self.recorder = recorder
        self._closed = False  # its stdout ended: no answer or message will come
        self._ids = itertools.count(1)
        self._answers: dict[Any, dict[str, Any]] = {}
        self._answered = threading.Condition()
        self._inbox: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self.seen: list[dict[str, Any]] = []  # notifications and requests taken from the inbox
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._reader.start()

    def __enter__(self) -> "AppServer":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _read(self) -> None:
        try:
            for line in self.proc.stdout:
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue  # a launcher's banner or log line, not a message
                if not isinstance(msg, dict):
                    continue
                self.recorder.write("in", msg)
                if "id" in msg and "method" not in msg:
                    with self._answered:
                        self._answers[msg["id"]] = msg
                        self._answered.notify_all()
                else:
                    self._inbox.put(msg)
        finally:
            try:
                self.recorder.flush()
            finally:  # whatever the recording does, nothing waits on a server that is gone
                with self._answered:
                    self._closed = True
                    self._answered.notify_all()
                self._inbox.put(None)

    def _stderr_tail(self, lines: int = 5) -> str:
        """The last ``lines`` lines of the server's stderr, scrubbed, to add to an error ("" without any)."""
        if self.stderr is None or not self.stderr.exists():
            return ""
        tail = [line for line in self.stderr.read_text(errors="replace").splitlines() if line.strip()][-lines:]
        return f" [stderr: {' | '.join(self.recorder.scrub(tail))}]" if tail else ""

    def _gone(self, what: str) -> SpikeError:
        try:
            code = self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            code = None
        return SpikeError(f"{what}: the app-server exited (code {code}){self._stderr_tail()}")

    def send(self, msg: dict[str, Any]) -> None:
        self.recorder.write("out", msg)
        try:
            self.proc.stdin.write(json.dumps(msg) + "\n")
            self.proc.stdin.flush()
        except (OSError, ValueError):  # a broken pipe, or stdin already closed
            raise self._gone(msg.get("method") or "reply") from None

    def request_raw(self, method: str, params: dict[str, Any] | None = None, timeout: float = 120) -> dict[str, Any]:
        """Send a request; return its whole answer (``result`` or ``error``)."""
        request_id = next(self._ids)
        self.send({"id": request_id, "method": method, "params": params or {}})
        with self._answered:
            self._answered.wait_for(lambda: request_id in self._answers or self._closed, timeout)
            answer = self._answers.pop(request_id, None)
        if answer is not None:
            return answer
        if self._closed:
            raise self._gone(method)
        raise SpikeError(f"{method} got no answer in {timeout:.0f}s{self._stderr_tail()}")

    def request(self, method: str, params: dict[str, Any] | None = None, timeout: float = 120) -> Any:
        answer = self.request_raw(method, params, timeout)
        if "error" in answer:
            raise SpikeError(f"{method}: {answer['error']}")
        return answer.get("result")

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        self.send({"method": method, **({"params": params} if params is not None else {})})

    def reply(self, request_id: Any, result: dict[str, Any]) -> None:
        self.send({"id": request_id, "result": result})

    def _take(self, timeout: float, what: str) -> dict[str, Any]:
        """The next message from the inbox; ``queue.Empty`` after ``timeout``, ``SpikeError`` once the server is
        gone."""
        msg = self._inbox.get(timeout=timeout)
        if msg is None:
            self._inbox.put(None)  # every later call sees the end too
            raise self._gone(what)
        self.seen.append(msg)
        return msg

    def next(self, timeout: float = 180) -> dict[str, Any]:
        """The next notification or server request."""
        try:
            return self._take(timeout, "waiting for a message")
        except queue.Empty:
            raise SpikeError(f"nothing from the app-server in {timeout:.0f}s{self._stderr_tail()}") from None

    def wait(self, method: str, timeout: float = 180,
             where: Callable[[dict[str, Any]], bool] = lambda m: True) -> dict[str, Any]:
        """The first message (seen already, or next) with ``method`` that ``where`` accepts, within ``timeout``."""
        for msg in self.seen:
            if msg.get("method") == method and where(msg):
                return msg
        deadline = time.monotonic() + timeout
        while (left := deadline - time.monotonic()) > 0:
            try:
                msg = self._take(left, f"waiting for {method}")
            except queue.Empty:
                break
            if msg.get("method") == method and where(msg):
                return msg
        raise SpikeError(f"no {method} in {timeout:.0f}s{self._stderr_tail()}")

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
        took = time.monotonic() - start
        self.finish_recording(timeout)
        return took

    def finish_recording(self, timeout: float = 10) -> None:
        """Once the server has exited: wait (up to ``timeout``) for its last lines, then write the deltas still
        waiting on a stream that never completed."""
        self._reader.join(timeout)
        self.recorder.flush()


INHERITED_ENV = ("PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR")
"""``agent_corp.worker.spawn.INHERITED_ENV``, repeated: the spike imports nothing from the office."""
_RELEVANT = re.compile(r"(^|_)(PROXY|SSL|CERTS?|CA_BUNDLE|CODEX|OPENAI|NODE)(_|$)")
"""Whole ``_``-separated tokens of an upper-cased name (``https_proxy`` counts; ``NoDefault…`` doesn't)."""


def office_env(environ: dict[str, str]) -> dict[str, str]:
    """The environment the office gives an app-server: ``INHERITED_ENV`` and ``LC_*`` (not ``LC_TERMINAL*``), as
    ``daemon_env`` and then ``worker_env`` narrow it, plus ``CODEX_HOME`` when it is set."""
    return {k: v for k, v in environ.items()
            if k in INHERITED_ENV or k == "CODEX_HOME" or (k.startswith("LC_") and not k.startswith("LC_TERMINAL"))}


def missing_names(full: dict[str, str], narrow: dict[str, str]) -> dict[str, Any]:
    """The names (never the values) of variables ``full`` has and ``narrow`` lacks that could matter to Codex
    (proxies, certificates, Codex, OpenAI, Node), and how many others it lacks."""
    gone = [k for k in full if k not in narrow]
    relevant = sorted(k for k in gone if _RELEVANT.search(k.upper()))
    return {"relevant": relevant, "others": len(gone) - len(relevant)}


class Check:
    """One claim the spike checks, and the office work that waits on it (``gates``; empty when nothing does)."""

    def __init__(self, id: str, name: str, claim: str, gates: str) -> None:
        self.id, self.name, self.claim, self.gates = id, name, claim, gates


CHECKS = [
    Check("S1", "launch", "`codex app-server --listen stdio://` starts through the installed launcher and initializes "
          "with experimentalApi, and account/read says signed in (an account, or a login that needs no OpenAI auth); "
          "records `codex login status`'s exit code",
          "the app-server client's launch and initialize; the signed-out error; the doctor's Codex check"),
    Check("S2", "owner-load", "an owner load (sandbox, network config, on-request, reviewer user) works on your "
          "config.toml and comes back with approvalPolicy on-request and approvalsReviewer user",
          "the session's start params; whether the translator needs auto-review notes"),
    Check("S3", "sessions", "golden sessions recorded, each scenario with its own result: plain, command approve and "
          "decline, file change, interrupt with a pending approval, steer (turn/start on a busy thread answers the "
          "running turn), resume, and whether a thread that never ran a turn resumes; whether any auto-review showed "
          "up. ok when the four core scenarios are",
          "by scenario: the translator's golden tests (the core four); how a message to a busy thread is sent "
          "(steer); stale approval cards (interrupt); reloading and continuing a session (resume, resume-empty)"),
    Check("S4", "service-read", "thread/read on a second app-server while a turn runs in the first (recorded for "
          "later agent tools)", ""),
    Check("S5", "writer-lock", "thread/resume of a thread loaded in another app-server: Codex refuses, and with what",
          "the error when another app-server holds the thread"),
    Check("S6", "eof", "stdin EOF during a command: seconds until exit, and whether the command outlives it",
          "killing the app-server's process group when it dies"),
    Check("S7", "office-env", f"in the environment the office gives an app-server ({', '.join(INHERITED_ENV)}, "
          "LC_*, and CODEX_HOME when set): account/read with refreshToken says signed in, and a plain turn completes; "
          "the names of what that environment drops that could matter (proxies, certificates)",
          "the environment of every app-server the office starts"),
    Check("S8", "schema", "the pinned schema (generate-json-schema --experimental)",
          "the fake app-server's scripts; the translator's request and reply drift tests"),
]


def owner_load(cwd: str, sandbox: str = "read-only", *, network: bool = False) -> dict[str, Any]:
    """The owner-load params the office will pass on thread/start and thread/resume."""
    return {"cwd": cwd, "sandbox": sandbox, "approvalPolicy": "on-request", "approvalsReviewer": "user",
            "config": {"sandbox_workspace_write": {"network_access": network}}}


def signed_in(account_read: dict[str, Any]) -> dict[str, Any]:
    """What an ``account/read`` answer says about the sign-in. An account counts, and so does a login that needs no
    OpenAI auth (a launcher that signs in through its own gateway has no account)."""
    has_account = account_read.get("account") is not None
    requires = account_read.get("requiresOpenaiAuth")
    return {"signed_in": has_account or requires is False, "has_account": has_account,
            "requires_openai_auth": requires}


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


SCENARIOS = ("plain", "command-approve", "command-decline", "file-change", "interrupt", "steer", "resume",
             "resume-empty")
"""S3's scenarios, each on its own app-server and in its own ``sessions/<name>.jsonl``."""
CORE = ("plain", "command-approve", "command-decline", "file-change")
"""The scenarios S3's own ok needs; each later PR's gate names the scenarios it reads."""
RERUN_CHECKS = ("eof", "office-env")
"""Checks that ``--scenario`` can also run again: each turns on what one model turn does."""


def core_ok(scenarios: dict[str, dict[str, Any]]) -> bool:
    """Whether every scenario in ``CORE`` ran and is ok."""
    return all(scenarios.get(name, {}).get("ok") for name in CORE)


class Spike:
    """The checks, in order, against one ``codex`` binary, in a scratch repo under a temp folder that ``run``
    removes; outputs go under ``out``."""

    def __init__(self, codex: str, out: Path) -> None:
        self.codex, self.out = codex, out
        out.mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix="ac-codex-spike-"))
        self.ws = self.root / "ws"
        # The owner's git config may sign commits or run hooks; a scratch repo needs neither.
        git = ["git", "-c", "user.name=spike", "-c", "user.email=spike@example.com", "-c", "commit.gpgsign=false",
               "-c", f"core.hooksPath={os.devnull}"]
        try:
            self.ws.mkdir()
            subprocess.run([*git, "init", "-q"], cwd=self.ws, check=True)
            (self.ws / "README.md").write_text("Scratch repo for the agent-corp Codex spike.\n")
            subprocess.run([*git, "add", "-A"], cwd=self.ws, check=True)
            subprocess.run([*git, "commit", "-qm", "init"], cwd=self.ws, check=True)
        except BaseException:
            shutil.rmtree(self.root, ignore_errors=True)
            raise
        home, user = str(Path.home()), getpass.getuser()
        self.replacements = {str(self.ws): "/work/spike/ws", os.path.realpath(self.ws): "/work/spike/ws",
                             str(self.root): "/work/spike", os.path.realpath(self.root): "/work/spike",
                             home: "/home/owner", os.path.realpath(home): "/home/owner"}
        if codex_home := os.environ.get("CODEX_HOME"):
            self.replacements |= {codex_home: "/codex-home", os.path.realpath(codex_home): "/codex-home"}
        self.words = {user: "owner"} if len(user) >= 3 and user.lower() not in _PROTOCOL_WORDS else {}
        host = socket.gethostname()
        self.words |= {h: "owner-host" for h in (host, host.split(".")[0])
                       if len(h) >= 3 and h.lower() not in _PROTOCOL_WORDS}

    def scrubbed(self, value: Any) -> Any:
        """``value`` without the scratch paths, the home folder, ``CODEX_HOME``, the user, the host or an email."""
        return scrub(value, self.replacements, self.words)

    def server(self, name: str, env: dict[str, str] | None = None) -> AppServer:
        """A started and initialized app-server whose messages go to ``sessions/<name>.jsonl``."""
        server = AppServer([self.codex, "app-server", "--listen", "stdio://"], self.ws,
                           Recorder(self.out / "sessions" / f"{name}.jsonl", self.replacements, self.words), env,
                           stderr=self.root / f"{name}.stderr")
        try:
            server.request("initialize", {"clientInfo": {"name": "agent_corp_spike", "title": "AgentCorp spike",
                                                         "version": "0"}, "capabilities": {"experimentalApi": True}})
            server.notify("initialized")
        except BaseException:
            server.close(timeout=5)
            raise
        return server

    def start(self, server: AppServer, sandbox: str = "read-only") -> str:
        return server.request("thread/start", owner_load(str(self.ws), sandbox))["thread"]["id"]

    def turn(self, server: AppServer, thread: str, text: str, decide: str | None = None,
             asked: list[str] | None = None) -> dict[str, Any]:
        """Run a turn, answering each approval with ``decide`` (and adding its method to ``asked``); return
        turn/completed, or the first request when ``decide`` is None."""
        server.request("turn/start", {"threadId": thread, "input": _text(text)})
        while True:
            msg = server.next()
            if msg.get("method") == "turn/completed":
                return msg
            if "id" in msg:
                if decide is None:
                    return msg
                if asked is not None:
                    asked.append(msg["method"])
                server.reply(msg["id"], _decision(msg["method"], decide))

    def run(self) -> dict[str, dict[str, Any]]:
        """Every check; ``spike.json`` gets each one's result."""
        results: dict[str, dict[str, Any]] = {}
        thread = None
        try:
            for check in CHECKS:
                results[check.id], thread = self._one(check, thread)
        finally:
            shutil.rmtree(self.root, ignore_errors=True)
        return self._write(results)

    def _one(self, check: Check, thread: str | None) -> tuple[dict[str, Any], str | None]:
        """``check``'s result, and the thread of S3's plain scenario once S3 has run."""
        try:
            if check.id == "S3":
                detail, thread = self.sessions()
            elif check.id in ("S4", "S5") and thread is None:
                raise SpikeError("needs the thread of S3's plain scenario")
            else:
                detail = getattr(self, check.name.replace("-", "_"))(thread)
            ok = bool(detail.pop("ok", True))
        except Exception as exc:  # one failed check mustn't hide the others
            ok, detail = False, {"error": self.scrubbed(f"{type(exc).__name__}: {exc}")}
        return {"ok": ok, "detail": detail}, thread

    def _write(self, results: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
        """Write ``results``, scrubbed, to ``spike.json``, and return what was written."""
        results = self.scrubbed(results)
        (self.out / "spike.json").write_text(json.dumps(results, indent=2) + "\n")
        return results

    def wait_command_started(self, server: AppServer) -> dict[str, Any]:
        """The next commandExecution ``item/started``, accepting any approval on the way; ``SpikeError`` when the
        turn completes without one."""
        while True:
            msg = server.next()
            if msg.get("method") == "turn/completed":
                raise SpikeError("the model ran no command")
            if "id" in msg:
                server.reply(msg["id"], _decision(msg["method"], "accept"))
            elif msg.get("method") == "item/started" and msg["params"]["item"]["type"] == "commandExecution":
                return msg

    def wait_completed(self, server: AppServer) -> dict[str, Any]:
        """The next ``turn/completed``, accepting any approval on the way."""
        while (msg := server.next()).get("method") != "turn/completed":
            if "id" in msg:
                server.reply(msg["id"], _decision(msg["method"], "accept"))
        return msg

    # --- the checks but S3 ------------------------------------------------------------

    def launch(self, _thread: Any) -> dict[str, Any]:
        version = subprocess.run([self.codex, "--version"], capture_output=True, text=True, timeout=60)
        login = subprocess.run([self.codex, "login", "status"], capture_output=True, text=True, timeout=60)
        with self.server("launch") as server:
            account = signed_in(server.request("account/read", {"refreshToken": False}))
        return {"ok": version.returncode == 0 and account["signed_in"], "version": version.stdout.strip(),
                "login_status_exit": login.returncode, **account}

    def owner_load(self, _thread: Any) -> dict[str, Any]:
        got = {}
        for sandbox in ("read-only", "workspace-write"):
            with self.server(f"owner-load-{sandbox}") as server:
                r = server.request("thread/start", owner_load(str(self.ws), sandbox))
                got[sandbox] = {k: r.get(k) for k in ("model", "approvalPolicy", "approvalsReviewer", "sandbox",
                                                      "activePermissionProfile")}
        ok = all(v["approvalPolicy"] == "on-request" and v["approvalsReviewer"] == "user" for v in got.values())
        return {"ok": ok, **got}

    def service_read(self, thread: str) -> dict[str, Any]:
        with self.server("service-read-a") as a, self.server("service-read-b") as b:
            a.request("thread/resume", {"threadId": thread, **owner_load(str(self.ws), "workspace-write")})
            a.request("turn/start", {"threadId": thread,
                                     "input": _text("Run `sleep 5` with the shell, then say done.")})
            self.wait_command_started(a)
            answer = b.request_raw("thread/read", {"threadId": thread, "includeTurns": True})
            self.wait_completed(a)
        return {"ok": "result" in answer, "error": answer.get("error")}

    def writer_lock(self, thread: str) -> dict[str, Any]:
        with self.server("writer-lock-a") as a, self.server("writer-lock-b") as b:
            a.request("thread/resume", {"threadId": thread, **owner_load(str(self.ws))})
            answer = b.request_raw("thread/resume", {"threadId": thread, **owner_load(str(self.ws))})
        return {"refused": "error" in answer, "error": answer.get("error")}

    def eof(self, _thread: Any) -> dict[str, Any]:
        s = self.server("eof")
        try:
            t = self.start(s, "workspace-write")
            s.request("turn/start", {"threadId": t, "input": _text("Run `sleep 120` with the shell.")})
            self.wait_command_started(s)
            seconds = s.close(timeout=90)
            try:
                os.killpg(s.proc.pid, 0)  # anything left in the app-server's group, such as the sleep
                left = True
            except (ProcessLookupError, PermissionError):
                left = False
            return {"seconds_to_exit": round(seconds, 1), "group_left": left}
        finally:
            # What is left in the group goes: the sleep, or the app-server itself when a step above failed.
            try:
                os.killpg(s.proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            s.proc.wait()
            s.finish_recording()

    def office_env(self, _thread: Any) -> dict[str, Any]:
        env = office_env(dict(os.environ))
        detail: dict[str, Any] = {"codex": self.scrubbed(self.codex),
                                  "codex_home_set": "CODEX_HOME" in os.environ,
                                  "missing": missing_names(dict(os.environ), env)}
        with self.server("office-env", env=env) as server:
            detail |= signed_in(server.request("account/read", {"refreshToken": True}))
            done = self.turn(server, self.start(server), "Reply with the single word: hello")
            detail["turn"] = done["params"]["turn"]["status"]
        return {"ok": detail["signed_in"] and detail["turn"] == "completed", **detail}

    def schema(self, _thread: Any) -> dict[str, Any]:
        version = subprocess.run([self.codex, "--version"], capture_output=True, text=True, timeout=60).stdout.strip()
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run([self.codex, "app-server", "generate-json-schema", "--experimental", "--out", tmp],
                           check=True, timeout=60)
            pin_schema(Path(tmp), self.out / "schema", version=version)
        return {"version": version}

    # --- S3 ---------------------------------------------------------------------------

    def sessions(self, only: set[str] | None = None) -> tuple[dict[str, Any], str | None]:
        """S3: the scenarios (or ``only`` those; ``resume`` brings ``plain``, whose thread it resumes). One that
        fails records its error, and the others still run."""
        wanted = [n for n in SCENARIOS if only is None or n in only or (n == "plain" and "resume" in only)]
        scenarios: dict[str, dict[str, Any]] = {}
        thread = None
        for name in wanted:
            try:
                result = getattr(self, "_" + name.replace("-", "_"))(thread)
            except Exception as exc:
                result = {"ok": False, "error": self.scrubbed(f"{type(exc).__name__}: {exc}")}
            thread = result.pop("thread", thread)
            scenarios[name] = {"ok": bool(result.pop("ok", True)), **result}
        seen = any('"item/autoApprovalReview/' in p.read_text() for p in (self.out / "sessions").glob("*.jsonl"))
        return {"ok": core_ok(scenarios), "scenarios": scenarios, "auto_review_seen": seen}, thread

    def rerun(self, names: list[str]) -> dict[str, dict[str, Any]]:
        """Run the S3 scenarios and ``RERUN_CHECKS`` in ``names`` again (one whose model didn't ask, or a network
        blip) and merge them into ``spike.json``."""
        try:
            results = json.loads((self.out / "spike.json").read_text())
            if scenarios := {n for n in names if n in SCENARIOS}:
                detail, _ = self.sessions(scenarios)
                s3 = results["S3"]["detail"]
                s3.setdefault("scenarios", {}).update(detail["scenarios"])
                s3["auto_review_seen"] = detail["auto_review_seen"]
                results["S3"]["ok"] = core_ok(s3["scenarios"])
            for check in CHECKS:
                if check.name in names and check.name in RERUN_CHECKS:
                    results[check.id], _ = self._one(check, None)
        finally:
            shutil.rmtree(self.root, ignore_errors=True)
        return self._write(results)

    def _plain(self, _thread: Any) -> dict[str, Any]:
        with self.server("plain") as s:
            thread = self.start(s)
            status = self.turn(s, thread, "Reply with the single word: hello")["params"]["turn"]["status"]
        return {"ok": status == "completed", "status": status, "thread": thread}

    def _approval(self, name: str, text: str, decide: str, kind: str) -> dict[str, Any]:
        """A turn that should ask for a ``kind`` approval, answered with ``decide``; ok only when Codex asked."""
        asked: list[str] = []
        with self.server(name) as s:
            status = self.turn(s, self.start(s), text, decide, asked)["params"]["turn"]["status"]
        return {"ok": status == "completed" and kind in asked, "status": status, "asked": asked}

    def _command_approve(self, _thread: Any) -> dict[str, Any]:
        return self._approval("command-approve", "Run the shell command `touch spike-approved.txt` here. Don't use "
                              "apply_patch.", "accept", "item/commandExecution/requestApproval")

    def _command_decline(self, _thread: Any) -> dict[str, Any]:
        return self._approval("command-decline", "Run the shell command `touch spike-declined.txt` here. Don't use "
                              "apply_patch.", "decline", "item/commandExecution/requestApproval")

    def _file_change(self, _thread: Any) -> dict[str, Any]:
        return self._approval("file-change", "Create notes.md containing the one line `hi`, using apply_patch.",
                              "accept", "item/fileChange/requestApproval")

    def _interrupt(self, _thread: Any) -> dict[str, Any]:
        with self.server("interrupt") as s:
            t = self.start(s)
            pending = self.turn(s, t, "Run the shell command `touch spike-wait.txt` here. Don't use apply_patch.")
            if pending.get("method") == "turn/completed":  # the model ran nothing that needed an approval
                return {"ok": False, "asked": False}
            s.request("turn/interrupt", {"threadId": t, "turnId": pending["params"]["turnId"]})
            status = s.wait("turn/completed")["params"]["turn"]["status"]
            resolved = any(m.get("method") == "serverRequest/resolved" for m in s.seen)
        return {"ok": status == "interrupted", "status": status, "resolved_sent": resolved}

    def _steer(self, _thread: Any) -> dict[str, Any]:
        with self.server("steer") as s:
            t = self.start(s, "workspace-write")
            loop = "Run `for i in 1 2 3 4 5 6 7 8; do echo $i; sleep 1; done` with the shell, then summarize it."
            first = s.request("turn/start", {"threadId": t, "input": _text(loop)})["turn"]["id"]
            self.wait_command_started(s)
            second = s.request("turn/start", {"threadId": t, "input": _text("Also say pineapple in the summary.")})
            status = self.wait_completed(s)["params"]["turn"]["status"]
        return {"ok": status == "completed", "same_turn": first == second["turn"]["id"]}

    def _resume(self, thread: str | None) -> dict[str, Any]:
        if thread is None:
            raise SpikeError("needs the plain scenario's thread")
        with self.server("resume") as s:
            r = s.request("thread/resume", {"threadId": thread, **owner_load(str(self.ws))})
            status = self.turn(s, thread, "Say hello once more.")["params"]["turn"]["status"]
        return {"ok": status == "completed", "turns": len(r["thread"].get("turns") or []), "status": status,
                "model": r.get("model")}

    def _resume_empty(self, _thread: Any) -> dict[str, Any]:
        with self.server("empty-thread-a") as s:
            empty = self.start(s)
        with self.server("empty-thread-b") as s:
            answer = s.request_raw("thread/resume", {"threadId": empty, **owner_load(str(self.ws))})
        return {"resumed": "result" in answer, "error": answer.get("error")}


def main(argv: list[str] | None = None) -> int:
    """Run the spike and print its checklist; exit 1 when a check that other work waits on fails, 2 without
    ``codex`` (or without a full run's ``spike.json`` to merge ``--scenario`` into)."""
    parser = argparse.ArgumentParser(prog="codex_spike", description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--codex", default="codex",
                        help="the codex binary to check, a name on PATH or a path (default: codex); for a "
                             "non-default install, also export the CODEX_HOME it uses")
    parser.add_argument("--scenario", action="append", choices=(*SCENARIOS, *RERUN_CHECKS),
                        help="run only this S3 scenario (or the eof or office-env check) again and merge it into "
                             "spike.json (repeatable)")
    args = parser.parse_args(argv)
    codex = shutil.which(args.codex)
    if codex is None:
        print(f"{args.codex} is not on PATH")
        return 2
    if args.scenario and not (args.out / "spike.json").exists():
        print(f"{args.out / 'spike.json'} is missing: run the full spike first")
        return 2
    spike = Spike(codex, args.out)
    results = spike.rerun(args.scenario) if args.scenario else spike.run()
    print(checklist(results), end="")
    gating = [c.id for c in CHECKS if c.gates]
    return 0 if all(results[i]["ok"] for i in gating) else 1


if __name__ == "__main__":
    raise SystemExit(main())

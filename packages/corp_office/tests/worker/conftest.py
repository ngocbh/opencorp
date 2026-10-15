"""Fixtures for worker tests: a fake LLM, a pinned company tree, a store, and a registry."""

import os
import socket
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest

from agent_corp.store import Store
from agent_corp.testing.fake_llm import LLM_CONFIG, FakeLLM
from agent_corp.worker.channel import Channel
from agent_corp.worker.job import Job
from agent_corp.worker.main import main
from agent_corp.worker.rpc import REQUEST_REPLIES, BaseHandlers, Rpc, answer_request
from agent_corp.worker.spawn import WorkerRegistry
from tests.company.conftest import CHAT


def agent_flow(name: str, *, node: str = "", top: str = "") -> str:
    """A one-agent flow: input ``message``, output the agent's reply."""
    return (f"id: {name}\nname: {name}\n{top}input:\n  message: !str\nnodes:\n  reply:\n    kind: agent\n"
            f"{node}    input:\n      message: ${{input.message}}\n    output: str\n"
            f"    prompt: \"${{message}}\"\noutput: ${{reply.output}}\n")


ECHO = agent_flow("echo")
ASK = agent_flow("ask", node="    tools: [ask_user]\n")
TOOLS = agent_flow("tools", node="    tools: [toolbox]\n")
STEERABLE = agent_flow("steerable", node="    tools: [toolbox]\n    steerable: true\n")
PROFILED = agent_flow("profiled", top="long_term_memory: profile\n")
SESSION = agent_flow("session", node="    long_term_memory: session\n")
SKILLED = agent_flow("skilled", node="    skills: all\n")


def write_files(root: Path, files: dict[str, str]) -> Path:
    for rel, text in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    return root


@pytest.fixture
def fake_llm():
    with FakeLLM() as fake:
        yield fake


@pytest.fixture
def pin(tmp_path):
    return write_files(tmp_path / "pin", {
        "flows/echo.yaml": ECHO, "flows/ask.yaml": ASK, "flows/chat.yaml": CHAT,
        "flows/tools.yaml": TOOLS, "flows/steerable.yaml": STEERABLE,
        "flows/profiled.yaml": PROFILED, "flows/session.yaml": SESSION, "flows/skilled.yaml": SKILLED,
    })


@contextmanager
def office_end(handlers: BaseHandlers, *, threaded: bool = False):
    """An in-process channel pair: yields the worker side's ``Rpc``; the office side answers with ``handlers``.

    With ``threaded``, each request is answered on its own thread, as ``spawn.Worker`` does.
    """
    office_sock, worker_sock = socket.socketpair()
    office, worker = Channel(office_sock), Channel(worker_sock)
    rpc = Rpc(worker)

    def answer(frame):
        office.send(answer_request(frame, handlers, None))

    def serve_office():
        try:
            while True:
                frame = office.recv()
                if frame["type"] not in REQUEST_REPLIES:
                    continue
                if threaded:
                    threading.Thread(target=answer, args=(frame,), daemon=True).start()
                else:
                    answer(frame)
        except Exception:
            pass

    def serve_worker():
        try:
            while True:
                rpc.deliver(worker.recv())
        except Exception:
            pass

    threads = [threading.Thread(target=t, daemon=True) for t in (serve_office, serve_worker)]
    for t in threads:
        t.start()
    try:
        yield rpc
    finally:
        office.close()
        worker.close()


@pytest.fixture
def worker_main(monkeypatch):
    """Run the worker's ``main`` on a thread over a socket pair.

    Calling the fixture starts it and returns the office's ``Channel``, the thread, and a dict
    holding the worker's ``fd`` that gets ``code`` when ``main`` returns (or ``exit`` if the
    worker would have called ``os._exit``).
    """
    runs: list[tuple[Channel, threading.Thread]] = []

    def fake_exit(code: int) -> None:
        raise SystemExit(code)

    monkeypatch.setattr(os, "_exit", fake_exit)

    def start() -> tuple[Channel, threading.Thread, dict[str, Any]]:
        office_sock, worker_sock = socket.socketpair()
        fd = worker_sock.detach()
        os.set_inheritable(fd, True)  # as pass_fds leaves it in a real worker
        out: dict[str, Any] = {"fd": fd}

        def target() -> None:
            try:
                out["code"] = main(["--fd", str(fd)])
            except SystemExit as exc:
                out["exit"] = exc.code

        thread = threading.Thread(target=target, daemon=True)
        thread.start()
        office = Channel(office_sock)
        runs.append((office, thread))
        return office, thread, out

    yield start
    for office, thread in runs:
        office.close()
        thread.join(10)


@pytest.fixture
def store(tmp_path):
    with Store(tmp_path / "office" / "store.sqlite") as s:
        yield s


@pytest.fixture
def session_dir(tmp_path):
    return tmp_path / "sessions" / "s1"


@pytest.fixture
def registry(store):
    reg = WorkerRegistry(store)
    yield reg
    reg.close_all(timeout=5)


@pytest.fixture
def make_job(tmp_path, pin, fake_llm):
    def make(flow: str = "flows/echo.yaml", **fields: Any) -> Job:
        run_id = fields.pop("run_id", "r1")
        values = {"kind": "chat", "session_id": "s1", "run_id": run_id, "person": "minh",
                  "pin": str(pin), "flow": flow, "log": str(tmp_path / "runs" / f"{run_id}.jsonl"),
                  "inputs": {"message": "hi"}, "llm_config": LLM_CONFIG, "env": fake_llm.env()}
        return Job(**(values | fields))
    return make


class Recorder(BaseHandlers):
    """Handlers that record every frame and answer questions from a list."""

    def __init__(self, answers: list[Any] | None = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.frames: list[dict[str, Any]] = []
        self.asked: list[dict[str, Any]] = []
        self.answers = list(answers or [])
        self.left: list[tuple[str, list[str]]] = []
        self.left_event = threading.Event()
        self.order: list[str] = []  # the types of steer_left, result, and error frames, in order
        self.outcome: dict[str, Any] | None = None
        self.returncode: int | None = None

    def event(self, worker, frame):
        self.frames.append(frame)

    def stream(self, worker, frame):
        self.frames.append(frame)

    def steer_left(self, worker, node_id, texts):
        self.left.append((node_id, texts))
        self.order.append("steer_left")
        self.left_event.set()

    def result(self, worker, frame):
        self.outcome = frame
        self.order.append("result")

    def error(self, worker, frame):
        self.outcome = frame
        self.order.append("error")

    def exited(self, worker, returncode):
        self.returncode = returncode

    def ask_user(self, worker, request):
        self.asked.append(request)
        return self.answers.pop(0)

    def names(self) -> list[str]:
        return [f.get("name", f["type"]) for f in self.frames]


def run(registry: WorkerRegistry, job: Job, handlers: Recorder, session_dir: Path, timeout: float = 30) -> Recorder:
    """Spawn ``job`` and wait for its worker to exit."""
    worker = registry.spawn(job, session_dir, handlers)
    assert worker.wait(timeout) is not None, "the worker did not exit"
    return handlers

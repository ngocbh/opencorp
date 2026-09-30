"""Fixtures for worker tests: a fake LLM, a pinned company tree, a store, and a registry."""

import socket
import threading
from contextlib import contextmanager
from pathlib import Path

import pytest

from agent_corp.testing.fake_llm import FakeLLM
from agent_corp.worker.channel import Channel
from agent_corp.worker.rpc import REQUEST_REPLIES, BaseHandlers, Rpc, answer_request
from tests.company.conftest import CHAT


def agent_flow(name: str, *, node: str = "", top: str = "") -> str:
    """A one-agent flow: input ``message``, output the agent's reply."""
    return (f"id: {name}\nname: {name}\n{top}input:\n  message: str\nnodes:\n  reply:\n    kind: agent\n"
            f"{node}    input:\n      message: ${{input.message}}\n    output: str\n"
            f"    prompt: \"${{message}}\"\noutput: ${{reply.output}}\n")


ECHO = agent_flow("echo")
ASK = agent_flow("ask", node="    mode: tool_calling\n    tools: [ask_user]\n")
TOOLS = agent_flow("tools", node="    mode: tool_calling\n    tools: [toolbox]\n")
STEERABLE = agent_flow("steerable", node="    mode: tool_calling\n    tools: [toolbox]\n    steerable: true\n")
PROFILED = agent_flow("profiled", top="long_term_memory: profile\n")
SESSION = agent_flow("session", top="long_term_memory: session\n")
SKILLED = agent_flow("skilled", node="    mode: tool_calling\n    skills: all\n")


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

"""The run worker process: read one job from the office, run it with composer, report, exit."""

import argparse
import os
import socket
import sys
import threading
import traceback
from contextlib import ExitStack
from pathlib import Path
from typing import Any

from agent_composer.compose.skills import load_skills
from agent_composer.memory.profile import ProfileMemory
from agent_composer.memory.session import SessionMemory
from agent_composer.run import resume_flow, run_flow
from agent_composer.skills.catalog import Skill

from agent_corp.company.flows import load_confined
from agent_corp.worker.channel import Channel, ChannelClosed, FrameTooLarge, jsonable
from agent_corp.worker.inbox import Inbox
from agent_corp.worker.job import Job
from agent_corp.worker.remote_store import RemoteMarkdownStore
from agent_corp.worker.rpc import REPLY_TYPES, Rpc, ask_user_stub, remote_tool

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_ORPHANED = 3
LINGER = 5.0  # seconds to keep answering steers after the last frame, waiting for the office to close
_FINISHED = ("NodeSucceeded", "NodeSkipped", "NodeFailed")


def pick_skills(pin: Path, handle: str, names: list[str]) -> dict[str, Skill]:
    """The person's listed skills; a personal skill shadows a shared one of the same name."""
    found = load_skills([pin / "people" / handle / "skills", pin / "shared" / "skills"], skip_invalid=True)
    return {name: found[name] for name in names if name in found}


def job_tools(job: Job, rpc: Rpc) -> dict[str, Any]:
    """composer's ``tools=``: each office group as remote tools, plus the ``ask_user`` stub."""
    tools: dict[str, Any] = {group: [remote_tool(rpc, group, spec) for spec in specs]
                             for group, specs in job.groups.items()}
    tools["ask_user"] = ask_user_stub(rpc)
    return tools


def job_memory(job: Job, rpc: Rpc, stack: ExitStack) -> dict[str, Any] | None:
    """composer's ``memory=`` for the job; session memories are closed by ``stack``."""
    memory: dict[str, Any] = {}
    for name, spec in job.memory.items():
        if spec.kind == "profile":
            memory[name] = ProfileMemory(RemoteMarkdownStore(rpc, spec.store), llm_config=spec.llm_config,
                                         max_chars=spec.max_chars)
        else:
            memory[name] = stack.enter_context(SessionMemory(
                history_budget_chars=spec.history_budget_chars, recent_turns=spec.recent_turns,
                storage=spec.storage))
    return memory or None


def run_job(job: Job, channel: Channel, rpc: Rpc, inbox: Inbox) -> dict[str, Any]:
    """Run ``job``, sending ``event``, ``stream``, and ``steer_left`` frames; return the result frame's fields."""
    os.environ.update(job.env)
    pin = Path(job.pin)
    flow = load_confined(pin, pin / job.flow)

    def on_event(event: Any) -> None:
        name, data = type(event).__name__, jsonable(event)
        texts: list[str] = []
        if name in _FINISHED:
            node_id = event.failure.node_id if name == "NodeFailed" else event.node_id
            if node_id and inbox.cut(node_id):
                data["interrupted"] = True  # composer ends an interrupted node as usual
            # Finish before the office sees the event, so a steer it sends afterwards is refused.
            texts = inbox.finish(node_id) if node_id else []
        channel.send({"type": "event", "name": name, "data": data})
        if texts:
            channel.send({"type": "steer_left", "node_id": node_id, "texts": texts})

    def on_stream(chunk: Any) -> None:
        channel.send({"type": "stream", **jsonable(chunk)})

    with ExitStack() as stack:
        common: dict[str, Any] = {
            "log": job.log, "num_workers": job.num_workers, "on_event": on_event, "on_stream": on_stream,
            "memory": job_memory(job, rpc, stack), "tools": job_tools(job, rpc),
            "skills": pick_skills(pin, job.person, job.skills), "steering": inbox,
        }
        if job.kind == "chat":
            Path(job.log).parent.mkdir(parents=True, exist_ok=True)
            result = run_flow(flow, job.inputs, run_id=job.run_id, llm_config=job.llm_config,
                              learnable=job.learnable, **common)
        else:
            # composer never records a host key, so a resumed run (and its backward) needs it again.
            result = resume_flow(flow, api_key=(job.llm_config or {}).get("api_key"), **common)
        backward = None
        if job.kind == "backward":
            outcome = result.backward(job.feedback)
            backward = {"status": outcome.status, "failure": jsonable(outcome.failure)}
    return {"status": result.status, "run_id": result.run_id, "output": jsonable(result.output),
            "failure": jsonable(result.failure), "backward": backward}


def read_frames(channel: Channel, rpc: Rpc, inbox: Inbox, finished: threading.Event,
                office_closed: threading.Event) -> None:
    """Route office frames until the channel closes; then exit (code 3) unless the job has finished.

    A refused steer is answered with ``steer_left`` on this thread. That send can only block
    if the office stops reading, and the office's reader never waits on sending to us.
    """
    try:
        while True:
            frame = channel.recv()
            kind = frame.get("type")
            if kind == "steer":
                if not inbox.steer(frame["node_id"], frame["text"]):
                    channel.send({"type": "steer_left", "node_id": frame["node_id"], "texts": [frame["text"]]})
            elif kind == "interrupt":
                inbox.interrupt(frame["node_id"])
            elif kind in REPLY_TYPES:
                rpc.deliver(frame)
    except ChannelClosed:
        pass
    except BaseException:
        traceback.print_exc()
    office_closed.set()
    if not finished.is_set():
        # The office is gone: nobody can answer a question or read the result.
        os._exit(EXIT_ORPHANED)


def main(argv: list[str] | None = None) -> int:
    """Run the job the office sends on the inherited socket ``--fd``; return the exit code.

    The last frames are a ``steer_left`` for every steer the run never read, then
    ``result`` (or ``error``). After them the worker keeps answering steers with
    ``steer_left`` until the office closes its side (or ``LINGER`` passes), so a steer
    the office sent as the run ended is never lost.
    """
    parser = argparse.ArgumentParser(prog="agent_corp.worker.main")
    parser.add_argument("--fd", type=int, required=True)
    args = parser.parse_args(argv)
    # pass_fds made it inheritable; a tool's subprocess holding it would keep the channel open.
    os.set_inheritable(args.fd, False)
    channel = Channel(socket.socket(fileno=args.fd))
    try:
        start = channel.recv()
    except ChannelClosed:
        channel.close()
        return EXIT_ORPHANED
    rpc, inbox = Rpc(channel), Inbox()
    finished, office_closed = threading.Event(), threading.Event()
    threading.Thread(target=read_frames, args=(channel, rpc, inbox, finished, office_closed),
                     name="office-reader", daemon=True).start()
    try:
        if start.get("type") != "start":
            raise ValueError(f"expected a start frame, got {start.get('type')!r}")
        last, code = {"type": "result", **run_job(Job.model_validate(start["job"]), channel, rpc, inbox)}, EXIT_OK
    except BaseException as exc:
        last = {"type": "error", "message": f"{type(exc).__name__}: {exc}", "traceback": traceback.format_exc()}
        code = EXIT_FAILED
    left = [{"type": "steer_left", "node_id": n, "texts": t} for n, t in inbox.close().items()]
    finished.set()
    code = _report(channel, [*left, last], code)
    office_closed.wait(LINGER)
    channel.close()
    return code


def _report(channel: Channel, frames: list[dict[str, Any]], code: int) -> int:
    """Send the closing frames; a frame too large to send becomes an error frame."""
    try:
        for frame in frames:
            try:
                channel.send(frame)
            except FrameTooLarge as exc:
                channel.send({"type": "error", "message": f"FrameTooLarge: {exc}", "traceback": ""})
                code = EXIT_FAILED
    except ChannelClosed:
        return EXIT_ORPHANED
    return code


if __name__ == "__main__":
    sys.exit(main())

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
from agent_corp.worker.job import Job
from agent_corp.worker.remote_store import RemoteMarkdownStore
from agent_corp.worker.rpc import REPLY_TYPES, Rpc, ask_user_stub, remote_tool

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_ORPHANED = 3


def pick_skills(pin: Path, person_id: str, names: list[str]) -> dict[str, Skill]:
    """The person's listed skills; a personal skill shadows a shared one of the same name."""
    found = load_skills([pin / "people" / person_id / "skills", pin / "shared" / "skills"], skip_invalid=True)
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


def run_job(job: Job, channel: Channel, rpc: Rpc) -> dict[str, Any]:
    """Run ``job``, sending ``event`` and ``stream`` frames; return the result frame's fields."""
    os.environ.update(job.env)
    pin = Path(job.pin)
    flow = load_confined(pin, pin / job.flow)

    def on_event(event: Any) -> None:
        channel.send({"type": "event", "name": type(event).__name__, "data": jsonable(event)})

    def on_stream(chunk: Any) -> None:
        channel.send({"type": "stream", **jsonable(chunk)})

    with ExitStack() as stack:
        common: dict[str, Any] = {
            "log": job.log, "num_workers": job.num_workers, "on_event": on_event, "on_stream": on_stream,
            "memory": job_memory(job, rpc, stack), "tools": job_tools(job, rpc),
            "skills": pick_skills(pin, job.person_id, job.skills),
        }
        if job.kind == "chat":
            Path(job.log).parent.mkdir(parents=True, exist_ok=True)
            result = run_flow(flow, job.inputs, run_id=job.run_id, llm_config=job.llm_config,
                              learnable=job.learnable, **common)
        else:
            result = resume_flow(flow, **common)
        backward = None
        if job.kind == "backward":
            outcome = result.backward(job.feedback)
            backward = {"status": outcome.status, "failure": jsonable(outcome.failure)}
    return {"status": result.status, "run_id": result.run_id, "output": jsonable(result.output),
            "failure": jsonable(result.failure), "backward": backward}


def read_frames(channel: Channel, rpc: Rpc, finished: threading.Event) -> None:
    """Route office frames until the channel closes; then exit (code 3) unless the job has finished."""
    try:
        while True:
            frame = channel.recv()
            if frame.get("type") in REPLY_TYPES:
                rpc.deliver(frame)
    except ChannelClosed:
        pass
    except BaseException:
        traceback.print_exc()
    if not finished.is_set():
        # The office is gone: nobody can answer a question or read the result.
        os._exit(EXIT_ORPHANED)


def main(argv: list[str] | None = None) -> int:
    """Run the job the office sends on the inherited socket ``--fd``; return the exit code."""
    parser = argparse.ArgumentParser(prog="agent_corp.worker.main")
    parser.add_argument("--fd", type=int, required=True)
    args = parser.parse_args(argv)
    channel = Channel(socket.socket(fileno=args.fd))
    try:
        start = channel.recv()
    except ChannelClosed:
        return EXIT_ORPHANED
    rpc, finished = Rpc(channel), threading.Event()
    threading.Thread(target=read_frames, args=(channel, rpc, finished), name="office-reader", daemon=True).start()
    try:
        if start.get("type") != "start":
            raise ValueError(f"expected a start frame, got {start.get('type')!r}")
        outcome = run_job(Job.model_validate(start["job"]), channel, rpc)
    except BaseException as exc:
        finished.set()
        return _report(channel, [{"type": "error", "message": f"{type(exc).__name__}: {exc}",
                                  "traceback": traceback.format_exc()}], EXIT_FAILED)
    finished.set()
    return _report(channel, [{"type": "result", **outcome}], EXIT_OK)


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

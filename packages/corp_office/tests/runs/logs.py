"""Synthetic Yian run logs for the reader's tests: one sorted-key JSON object per line, as Yian writes them, each
record's seq its line number."""

import json
from pathlib import Path

RUN = "01JA1H000000000000000000R1"
FP = "f" * 64


def line(seq: int, kind: str, payload: dict, *, schema: int = 9, **extra) -> bytes:
    """One record as Yian writes it (sorted keys, no spaces), with any extra envelope fields."""
    record = {"schema": schema, "run_id": RUN, "seq": seq, "kind": kind, "payload": payload, **extra}
    return json.dumps(record, sort_keys=True, separators=(",", ":")).encode() + b"\n"


def run_started(seq: int = 0, *, learnable: bool = True) -> bytes:
    return line(seq, "run_started", {"flow_fingerprint": FP, "learnable": learnable, "initial_pool": {},
                                     "start_wiring_override": {}, "num_workers": 0,
                                     "effective_llm_by_static_path": {"chat/reply": {"provider": "vllm",
                                                                                      "model": "stub"}}})


def started(seq: int, node_id: str, **extra) -> bytes:
    return line(seq, "node_started", {"node_id": node_id}, **extra)


def succeeded(seq: int, node_id: str, value: dict | None = None, evidence: dict | None = None, **extra) -> bytes:
    return line(seq, "node_succeeded", {"node_id": node_id, "commit_target": node_id, "value": value or {},
                                        "evidence": evidence, "forward_capture": None}, **extra)


def routed(seq: int, node_id: str, handle: str) -> bytes:
    return line(seq, "node_routed", {"node_id": node_id, "handle": handle, "terminal_failure": None,
                                     "evidence": None, "forward_capture": None})


def expanded(seq: int, node_id: str) -> bytes:
    return line(seq, "node_expanded", {"spawner_id": node_id, "seed": None, "prune_ids": [],
                                       "topology_digest": "0" * 64, "evidence": None, "forward_capture": None})


def failed(seq: int, node_id: str, message: str) -> bytes:
    return line(seq, "node_failed", {"failure": {"code": "agent_error", "message": message, "node_id": node_id,
                                                 "trace": [], "cause_type": "AuthError", "traceback": "Traceback"},
                                     "evidence": None, "forward_capture": None})


def resumed(seq: int, retried: list[str]) -> bytes:
    return line(seq, "run_resumed", {"retry_node_ids": retried, "num_workers": 0})


def chat_log(path: Path, turns: int = 2) -> Path:
    """A chat's log: run_started, the loop's start and expansion, ``turns`` turns of ask, route and reply, and the
    next turn's ask left open. Its last seq is ``3 + 6 * turns``."""
    out, seq = [run_started(0)], 1

    def add(record: bytes) -> None:
        nonlocal seq
        out.append(record)
        seq += 1

    add(started(seq, "chat"))
    add(expanded(seq, "chat"))
    for n in range(turns):
        add(started(seq, f"chat#{n}/ask"))
        add(succeeded(seq, f"chat#{n}/ask", {"output": "hi"}))
        add(started(seq, f"chat#{n}/route"))
        add(routed(seq, f"chat#{n}/route", "reply"))
        add(started(seq, f"chat#{n}/reply"))
        add(succeeded(seq, f"chat#{n}/reply", {"output": "hello"}))
    add(started(seq, f"chat#{turns}/ask"))
    path.write_bytes(b"".join(out))
    return path

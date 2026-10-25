/** Synthetic yian run logs for the run tests: one record per line as yian writes them, each record's seq its line
 *  number. Every int in a payload is a `bigint`, which yian's writer writes as an int. */
import fs from "node:fs"
import { logJson } from "@ngocbh/yian/run"

export const RUN = "01JA1H000000000000000000R1"
export const FP = "f".repeat(64)
export const AT = "2026-10-20T10:00:00.000Z"

/** One record as yian writes it (sorted keys, no spaces, UTF-8), with any extra envelope fields. */
export function line(
  seq: number,
  kind: string,
  payload: Record<string, unknown>,
  { schema = 22n, at = AT, ...extra }: { schema?: unknown; at?: string; [field: string]: unknown } = {},
): Buffer {
  return Buffer.from(logJson({ at, kind, payload, run_id: RUN, schema, seq: BigInt(seq), ...extra }) + "\n")
}

/** A `run_started` with every field yian requires. */
export function runStarted(seq = 0, { learnable = true }: { learnable?: boolean } = {}): Buffer {
  return line(seq, "run_started", {
    flow_fingerprint: FP,
    start_wiring_override: {},
    effective_llm_by_static_path: { "chat/reply": { provider: "vllm", model: "stub" } },
    num_workers: 0n,
    memory_snapshots: null,
    memories: null,
    memory_stacks: null,
    learnable,
    defaults: {},
    call_time_llm: null,
    flow: null,
    skills: {},
    tools: {},
    tool_groups: {},
    yian_version: "0.0.0",
    parent: null,
  })
}

export function started(seq: number, nodeId: string): Buffer {
  return line(seq, "node_started", { node_id: nodeId })
}

/** A value commit by `nodeId` under its own id as the key. */
export function committed(seq: number, nodeId: string, value: unknown, kind = "object"): Buffer {
  return line(seq, "pool_commit", { node_id: nodeId, key: nodeId, kind, value })
}

/** A success naming the commit at seq `commit`. */
export function succeeded(seq: number, nodeId: string, commit: number): Buffer {
  return line(seq, "node_succeeded", { node_id: nodeId, commit: BigInt(commit), messages: null, forward_capture: null })
}

export function routed(seq: number, nodeId: string, handle: string): Buffer {
  return line(seq, "node_routed", { node_id: nodeId, handle, terminal_failure: null, forward_capture: null })
}

export function expanded(seq: number, nodeId: string): Buffer {
  return line(seq, "node_expanded", {
    spawner_id: nodeId,
    prune_ids: [],
    topology_digest: "0".repeat(64),
    forward_capture: null,
  })
}

export function failed(seq: number, nodeId: string, message: string): Buffer {
  return line(seq, "node_failed", {
    failure: {
      code: "node.execute",
      message,
      node_id: nodeId,
      trace: [],
      cause_type: "AuthError",
      traceback: "Traceback",
    },
    forward_capture: null,
  })
}

export function resumed(seq: number, retried: string[]): Buffer {
  return line(seq, "run_resumed", { retry_node_ids: retried, num_workers: 0n, closed_calls: [] })
}

export function waiting(seq: number, nodeId: string): Buffer {
  return line(seq, "node_waiting", { node_id: nodeId, call_ids: ["c1"], waits: [], steer_inbox: null })
}

export function woken(seq: number, nodeId: string): Buffer {
  return line(seq, "node_woken", { node_id: nodeId, timed_out: [] })
}

/**
 * A chat's log at `file`: run_started, the loop's start and expansion, `turns` turns of ask, route and reply (each
 * success naming its commit), and the next turn's ask left open. Its last seq is `3 + 8 * turns`. Returns `file`.
 */
export function chatLog(file: string, turns = 2): string {
  const out = [runStarted(0)]
  let seq = 1
  const add = (make: (seq: number) => Buffer) => out.push(make(seq++))
  add((s) => started(s, "chat"))
  add((s) => expanded(s, "chat"))
  for (let n = 0; n < turns; n++) {
    add((s) => started(s, `chat#${n}/ask`))
    add((s) => committed(s, `chat#${n}/ask`, { output: "hi" }))
    add((s) => succeeded(s, `chat#${n}/ask`, s - 1))
    add((s) => started(s, `chat#${n}/route`))
    add((s) => routed(s, `chat#${n}/route`, "reply"))
    add((s) => started(s, `chat#${n}/reply`))
    add((s) => committed(s, `chat#${n}/reply`, { output: "hello" }))
    add((s) => succeeded(s, `chat#${n}/reply`, s - 1))
  }
  add((s) => started(s, `chat#${turns}/ask`))
  fs.writeFileSync(file, Buffer.concat(out))
  return file
}

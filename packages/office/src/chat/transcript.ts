/** A session's transcript: Message rows projected from its runs' logs. */
import path from "node:path"
import {
  checkMessage,
  iterRunRecords,
  type LiveViewCall,
  type Message as RunMessage,
  PoolCommitRecord,
  RunLogChangedError,
  type RunLogEntry,
  TypedValue,
} from "@ngocbh/yian/run"
import { Handle, type Message, type Part, type ToolPart } from "@opencorp/protocol"
import { INTERRUPTED_TEXT } from "../harness/translate.ts"
import { MAIN_CHAT } from "./turns.ts"

export { INTERRUPTED_TEXT }

/** The actor's view of its live runs: the model calls in flight of `runId`, or null when nothing runs it. */
export interface LiveCalls {
  calls(runId: string): readonly LiveViewCall[] | null
}

/** The run log records the transcript folds. */
const KINDS = [
  "node_started",
  "node_step",
  "pool_commit",
  "node_succeeded",
  "node_failed",
  "run_cancelled",
  "run_failed",
]

/** A message sent to the chat's inbox: its send commit's seq and time, and the message. */
interface Send {
  seq: number
  at: string
  message: RunMessage
}

/** A step a node recorded, as the log holds it: ints as bigints. */
type Step = Readonly<Record<string, unknown>>

/** What the render walks, in log order: an accepted take (the send seqs it consumed), a reply's first start, and a
 *  reply's step. */
type Item =
  | { kind: "take"; events: readonly number[] }
  | { kind: "start"; node: string; seq: number; at: string }
  | { kind: "step"; node: string; n: number; seq: number; at: string; step: Step }

/** What one run's log has said so far, folded record by record. */
interface Fold {
  /** Every send, by seq, in seq order. */
  sends: Map<number, Send>
  /** The seqs of the sends an accepted take consumed. */
  read: Set<number>
  /** Take commits no success has accepted yet: the send seqs each consumed, by commit seq. */
  takes: Map<number, readonly number[]>
  /** What the render walks, in log order. */
  items: Item[]
  /** The reply nodes that have started. */
  started: Set<string>
  /** The reply nodes that succeeded or failed. */
  settled: Set<string>
  /** Whether the run was cancelled or failed. */
  ended: boolean
  /** The end offset, seq and run id of the last record folded, where the next read resumes; a fold that has folded no
   *  record has no seq. The end is also the bytes the fold stands for in the cache. */
  end: number
  seq: number | null
  runId: string
}

/** A fold of no record yet. */
function emptyFold(): Fold {
  return {
    sends: new Map(),
    read: new Set(),
    takes: new Map(),
    items: [],
    started: new Set(),
    settled: new Set(),
    ended: false,
    end: 0,
    seq: null,
    runId: "",
  }
}

/** True for a run id that names a folder directly under the runs folder. */
function safeRunId(runId: string): boolean {
  return runId !== "" && runId !== "." && runId !== ".." && !/[/\\\0]/.test(runId)
}

/** A message's id: its run and the seq of the record that opens it, the seq padded so ids sort in log order. */
function messageId(runId: string, seq: number): string {
  return `${runId}:${String(seq).padStart(12, "0")}`
}

/**
 * A session's transcript, read from its runs' logs (`<runs>/<run_id>/log.jsonl`). Each run's fold is cached, least
 * recently read first, and each read folds only what its log added since; the cache keeps at most `maxBytes` of log
 * (32 MiB by default), and always the run just read.
 */
export class Transcript {
  private readonly runs: string
  private readonly maxBytes: number
  private readonly cache = new Map<string, Fold>()

  constructor(runs: string, options: { maxBytes?: number } = {}) {
    this.runs = runs
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024
  }

  /** The messages of the runs `runIds` (session_runs order), then the last run's queued messages. */
  messages(sessionId: string, runIds: readonly string[], live?: LiveCalls): Message[] {
    const out: Message[] = []
    runIds.forEach((runId, index) => {
      if (!safeRunId(runId)) return
      const state = this.read(runId)
      const last = index === runIds.length - 1
      render(out, sessionId, runId, state, last ? (live?.calls(runId) ?? null) : null, last)
      // A replaced run's unread sends were moved into the fresh run, so only the last run's are queued.
      if (last) {
        for (const send of state.sends.values()) {
          if (!state.read.has(send.seq)) out.push(userMessage(sessionId, runId, send))
        }
      }
    })
    return out
  }

  /** Forgets the reads of `runIds`, for a session that ended. */
  forget(runIds: Iterable<string>): void {
    for (const runId of runIds) this.cache.delete(runId)
  }

  /** The fold of the run `runId`, its cached fold read on to the end of its log; a run with no log yet has an empty
   *  fold, not cached. */
  private read(runId: string): Fold {
    const log = path.join(this.runs, runId, "log.jsonl")
    const cached = this.cache.get(runId)
    // Out of the cache while it is read, so a read that throws leaves no half-read fold, and put back last.
    this.cache.delete(runId)
    let state: Fold
    try {
      try {
        state = readOn(log, cached ?? emptyFold())
      } catch (error) {
        if (!(error instanceof RunLogChangedError)) throw error
        state = readOn(log, emptyFold())
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return emptyFold()
      throw error
    }
    this.cache.set(runId, state)
    let bytes = 0
    for (const fold of this.cache.values()) bytes += fold.end
    for (const [id, fold] of this.cache) {
      if (bytes <= this.maxBytes) break
      if (id === runId) continue
      this.cache.delete(id)
      bytes -= fold.end
    }
    return state
  }
}

/** Folds into `state` the records of the log `log` after the last one it folded; returns `state`. */
function readOn(log: string, state: Fold): Fold {
  // The resume point is the last folded record, so records of kinds not in KINDS after it are scanned again on the
  // next read; that rescan is bounded by the log's tail.
  const resume = state.seq === null ? {} : { afterOffset: state.end, runId: state.runId, afterSeq: state.seq }
  for (const entry of iterRunRecords(log, { ...resume, kinds: KINDS })) {
    fold(state, entry)
    state.end = entry.end
    state.seq = entry.seq
    state.runId = entry.runId
  }
  return state
}

/** Folds the log record `entry` into `state`. */
function fold(state: Fold, entry: RunLogEntry): void {
  const { seq, at, kind, nodeId } = entry
  const record = entry.envelope.record
  const inbox = MAIN_CHAT.inbox
  const reply = MAIN_CHAT.isReply(nodeId) ? nodeId! : null
  if (kind === "pool_commit" && record instanceof PoolCommitRecord) {
    if (record.value !== null && record.key === `${record.nodeId}.${inbox}`) {
      let message: RunMessage
      try {
        message = checkMessage(TypedValue.fromWire(record.value).toObject())
      } catch (error) {
        // Only a value that isn't a Message is skipped; checkMessage refuses one with a RangeError.
        if (!(error instanceof RangeError)) throw error
        return
      }
      state.sends.set(seq, { seq, at, message })
    } else if (record.take !== null && record.take.inbox === inbox && MAIN_CHAT.isTurn(record.nodeId)) {
      state.takes.set(seq, record.take.events)
    }
  } else if (kind === "node_succeeded") {
    const commit = (record as { commit: number }).commit
    const take = state.takes.get(commit)
    if (take !== undefined) {
      state.takes.delete(commit)
      state.items.push({ kind: "take", events: take })
      for (const event of take) state.read.add(event)
    }
    if (reply !== null) state.settled.add(reply)
  } else if (kind === "node_failed") {
    if (reply !== null) state.settled.add(reply)
  } else if (kind === "node_started") {
    // A run resumed after a crash starts the reply again; its message opened at the first start.
    if (reply !== null && !state.started.has(reply)) {
      state.started.add(reply)
      state.items.push({ kind: "start", node: reply, seq, at })
    }
  } else if (kind === "node_step") {
    if (reply !== null) {
      const { n, step } = record as { n: number; step: Step }
      state.items.push({ kind: "step", node: reply, n, seq, at, step })
      if (step.kind === "steer") for (const event of step.from as readonly bigint[]) state.read.add(Number(event))
    }
  } else if (kind === "run_cancelled" || kind === "run_failed") {
    state.ended = true
  }
}

/**
 * Appends to `out` the messages of the run `runId` from its fold `state`: each accepted take's user messages, each
 * reply's assistant message, and the user messages a steer read, between what the reply said before and after.
 * `live` is the model calls in flight of a run a worker runs, null when none runs it; `last` says the run is the
 * session's last.
 */
function render(
  out: Message[],
  sessionId: string,
  runId: string,
  state: Fold,
  live: readonly LiveViewCall[] | null,
  last: boolean,
): void {
  const open = new Map<string, Message>() // reply node -> its open message
  const calls = new Map<string, Map<string, ToolPart>>() // reply node -> its last model call's tool parts, by call id
  const unresolved = new Map<ToolPart, string>() // tool part without a result -> its reply node
  const waiting = new Set<ToolPart>() // tool parts whose call waits on the host
  const called = new Set<string>() // "<node>:<n>" of each model_call step
  // A message is emitted at its first part, so a reply that never shows anything adds no message.
  const add = (node: string, part: Part): void => {
    const message = open.get(node)
    if (message === undefined) return
    if (message.parts.length === 0) out.push(message)
    message.parts.push(part)
  }
  for (const item of state.items) {
    if (item.kind === "take") {
      for (const seq of item.events) {
        const send = state.sends.get(seq)
        if (send) out.push(userMessage(sessionId, runId, send))
      }
    } else if (item.kind === "start") {
      open.set(item.node, assistantMessage(sessionId, runId, item.seq, item.at))
    } else {
      const { node, n, step } = item
      if (step.kind === "model_call") called.add(`${node}:${n}`)
      if (step.kind === "model_call" && step.purpose === "chat" && step.error == null) {
        const output = step.output as { parts?: Record<string, unknown>[] } | null
        const parts = output?.parts ?? []
        const text = parts
          .filter((part) => part.type === "text" || part.type === "refusal")
          .map((part) => part.text as string)
          .join("")
        if (text !== "") add(node, { id: `${runId}:${node}:${n}`, type: "text", text })
        const current = new Map<string, ToolPart>()
        parts
          .filter((part) => part.type === "tool_call")
          .forEach((call, i) => {
            const args = call.arguments
            const input = isPlain(args)
              ? (plain(args) as Record<string, unknown>)
              : { arguments: call.raw_arguments ?? null }
            const part: ToolPart = {
              id: `${runId}:${node}:${n}:${i}`,
              type: "tool",
              call_id: call.id as string,
              tool: call.name as string,
              state: "running",
              input,
              output: {},
              error: null,
            }
            current.set(part.call_id, part)
            unresolved.set(part, node)
            add(node, part)
          })
        calls.set(node, current)
      } else if (step.kind === "tool_result") {
        const part = calls.get(node)?.get(step.call_id as string)
        if (part === undefined || !unresolved.has(part)) continue
        unresolved.delete(part)
        const text = step.output as string
        if (typeof step.closed === "string") Object.assign(part, { state: "interrupted", error: text })
        else if (step.is_error === true) Object.assign(part, { state: "error", error: text })
        else Object.assign(part, { state: "completed", output: text })
      } else if (step.kind === "pending") {
        const part = calls.get(node)?.get(step.tool_call_id as string)
        if (part !== undefined) waiting.add(part)
      } else if (step.kind === "steer") {
        // What the model says after reading a steer follows it, in a message of its own.
        for (const event of step.from as readonly bigint[]) {
          const send = state.sends.get(Number(event))
          if (send) out.push(userMessage(sessionId, runId, send))
        }
        if (open.has(node)) open.set(node, assistantMessage(sessionId, runId, item.seq, item.at))
      } else if (step.kind === "interrupted") {
        const tail = open.get(node)?.parts.at(-1)
        if (tail?.type === "text") tail.text += INTERRUPTED_TEXT
        else add(node, { id: `${runId}:${node}:${n}`, type: "text", text: INTERRUPTED_TEXT.trimStart() })
      }
    }
  }
  // A model call in flight shows its text so far, even none, under the id its step will get.
  for (const { node, n, text } of live ?? []) {
    if (!called.has(`${node}:${n}`)) add(node, { id: `${runId}:${node}:${n}`, type: "text", text })
  }
  // A call with no result runs on only while its reply can still finish it: a run nothing runs left it cut.
  for (const [part, node] of unresolved) {
    const running = last && !state.ended && !state.settled.has(node) && (waiting.has(part) || live !== null)
    part.state = running ? "running" : "interrupted"
  }
}

/** The assistant message the record at `seq` (at `at`) of the run `runId` opens, with no parts yet. */
function assistantMessage(sessionId: string, runId: string, seq: number, at: string): Message {
  const id = messageId(runId, seq)
  return { id, session_id: sessionId, role: "assistant", author: null, parts: [], created_at: at }
}

/** The user message of `send` in the run `runId`: its last text part, since earlier ones are the turn's context. */
function userMessage(sessionId: string, runId: string, send: Send): Message {
  const id = messageId(runId, send.seq)
  const text = send.message.parts.findLast((part) => part.type === "text") as { text: string } | undefined
  const author = Handle.safeParse(send.message.author)
  return {
    id,
    session_id: sessionId,
    role: "user",
    author: author.success ? author.data : null,
    parts: text === undefined ? [] : [{ id: `${id}:0`, type: "text", text: text.text }],
    created_at: send.at,
  }
}

/** True for an object that is a plain `{}` record. */
function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** `value` as plain JSON: a bigint (the log's int) as a number when it is a safe integer, else its decimal string,
 *  through arrays and plain objects. */
function plain(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? Number(value) : value.toString()
  }
  if (Array.isArray(value)) return value.map(plain)
  if (isPlain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]))
  return value
}

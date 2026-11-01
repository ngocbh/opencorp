/** A session's transcript: Message rows projected from its runs' logs. */
import fs from "node:fs"
import path from "node:path"
import {
  checkMessage,
  iterRunRecords,
  type LiveViewCall,
  type Message as RunMessage,
  PoolCommitRecord,
  RunLogChangedError,
  TypedValue,
} from "@ngocbh/yian/run"
import { Handle, type Message, type Part, type ToolPart } from "@opencorp/protocol"
import { INTERRUPTED_TEXT } from "../harness/translate.ts"
import { CHUNK, HUGE_LINE } from "../runs/reader.ts"
import { MAIN_CHAT } from "./turns.ts"

export { INTERRUPTED_TEXT }

/** The actor's view of its live runs: the model calls in flight of `runId`, or null when nothing runs it. */
export interface LiveCalls {
  calls(runId: string): readonly LiveViewCall[] | null
}

/** The run log records the transcript folds. */
const KINDS: ReadonlySet<string> = new Set([
  "node_started",
  "node_step",
  "pool_commit",
  "node_succeeded",
  "node_failed",
  "run_cancelled",
  "run_failed",
])

/** The longest log line the transcript parses (Run Logs' HUGE_LINE): yian's reader holds a line whole, and parsing it
 *  takes several times its size, so a longer one is read by its first and last bytes only. */
export const LINE_CAP = HUGE_LINE
/** About how many bytes past a fold's end one scan looks at before yian's reader reads them. */
const SCAN_WINDOW = 8 * CHUNK
/** How long a refresh reads at a time before it yields to the event loop, in milliseconds. */
const SLICE_MS = 10
/** The bytes of a line over the cap read for its kind and fields, and for its seq. */
const HEAD_BYTES = 1024
const TAIL_BYTES = 64
/** What the cache charges each thing a fold holds besides its JSON. */
const OVERHEAD = 64

// yian writes sorted-key JSON with no spaces, so a line over the cap gives its leading scalar fields (an envelope's
// `at` and `kind`, a step's `n`, `node_id`, `call_id`, `closed`, `is_error` and `kind`) without being parsed; its seq
// ends it.
const PAIR = /^"([a-z_]{1,64})":(null|true|false|-?[0-9]{1,16}|"(?:[^"\\\n]|\\.){0,512}")([,}])/
const SEQ = /,"seq":(0|[1-9][0-9]{0,15})\}\n$/

/** The text of a reply step whose log line is too large to read: the line's size. */
export function tooLargeText(size: number): string {
  return `(too large to show: ${(size / 2 ** 20).toFixed(1)} MiB)`
}

/** A message sent to the chat's inbox: its send commit's seq and time, and what the transcript shows of it. */
interface Send {
  seq: number
  at: string
  message: Pick<RunMessage, "author" | "parts">
}

/** A step a node recorded: as the log holds it (ints as bigints) when folded, then the copy `slim` keeps. */
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
   *  record has no seq. */
  end: number
  seq: number | null
  runId: string
  /** About how many bytes of memory what the fold keeps takes: what the cache charges it. */
  held: number
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
    held: 0,
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
 * recently read first, and each read folds only what its log added since; the cache keeps folds holding at most
 * `maxBytes` (32 MiB by default), and always the run just read. A fold keeps copies of only what it shows, so a large
 * log whose transcript is small stays cached. A log line over `lineCap` (LINE_CAP by default) is never parsed: a reply
 * step shows its size instead.
 */
export class Transcript {
  private readonly runs: string
  private readonly maxBytes: number
  private readonly lineCap: number
  private readonly cache = new Map<string, Fold>()
  private readonly refreshing = new Map<string, Promise<void>>()

  constructor(runs: string, options: { maxBytes?: number; lineCap?: number } = {}) {
    this.runs = runs
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024
    this.lineCap = options.lineCap ?? LINE_CAP
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

  /** The id of the first message of the reply still running in the run `runId` (its last reply, if it started, hasn't
   *  succeeded or failed, and the run wasn't cancelled or failed), or null. */
  runningReply(runId: string): string | null {
    if (!safeRunId(runId)) return null
    const state = this.read(runId)
    const start = state.items.findLast((item) => item.kind === "start")
    if (state.ended || start === undefined || state.settled.has(start.node)) return null
    return messageId(runId, start.seq)
  }

  /** Reads the logs of the runs `runIds` on, about SLICE_MS at a time with the event loop served in between, so the
   *  synchronous reads after it (`messages`, `runningReply`) read only what was added since. Calls made while a run's
   *  refresh runs share it. A run's refresh stops early once its fold leaves the cache (forgotten, or evicted).
   *  Rejects as `messages` throws for a log it can't read. */
  async refresh(runIds: readonly string[]): Promise<void> {
    for (const runId of runIds) {
      if (!safeRunId(runId)) continue
      let running = this.refreshing.get(runId)
      if (running === undefined) {
        running = this.refreshRun(runId).finally(() => this.refreshing.delete(runId))
        this.refreshing.set(runId, running)
      }
      await running
    }
  }

  /** Forgets the reads of `runIds`, for a session that ended. */
  forget(runIds: Iterable<string>): void {
    for (const runId of runIds) this.cache.delete(runId)
  }

  private async refreshRun(runId: string): Promise<void> {
    for (;;) {
      if (this.slice(runId, performance.now() + SLICE_MS).done) return
      await new Promise((resolve) => setImmediate(resolve))
      if (!this.cache.has(runId)) return
    }
  }

  /** The fold of the run `runId`, its cached fold read on to the end of its log; a run with no log yet has an empty
   *  fold, not cached. */
  private read(runId: string): Fold {
    return this.slice(runId, Infinity).fold
  }

  /** The fold of the run `runId`, its cached fold read on until its log's end (`done`) or `deadline` (a
   *  `performance.now()` time); a run with no log yet has an empty fold, not cached. */
  private slice(runId: string, deadline: number): { fold: Fold; done: boolean } {
    const log = path.join(this.runs, runId, "log.jsonl")
    const cached = this.cache.get(runId)
    // Out of the cache while it is read, so a read that throws leaves no half-read fold, and put back last.
    this.cache.delete(runId)
    let state = cached ?? emptyFold()
    let done: boolean
    try {
      try {
        done = readOn(log, runId, state, this.lineCap, deadline)
      } catch (error) {
        if (!(error instanceof RunLogChangedError)) throw error
        state = emptyFold()
        done = readOn(log, runId, state, this.lineCap, deadline)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return { fold: emptyFold(), done: true }
      throw error
    }
    this.cache.set(runId, state)
    let bytes = 0
    for (const fold of this.cache.values()) bytes += fold.held
    for (const [id, fold] of this.cache) {
      if (bytes <= this.maxBytes) break
      if (id === runId) continue
      this.cache.delete(id)
      bytes -= fold.held
    }
    return { fold: state, done }
  }
}

/** Where a read of `log` from `from` stops (`stop`): the end of the last complete line scanned, CHUNK at a time for
 *  newlines only, before the first line over `cap` (`big`, its start and end, or null). `more` says the scan stopped
 *  after about SCAN_WINDOW bytes with more to scan. A line over `cap` with no newline yet stops the scan before it.
 *  Throws RunLogChangedError when the log is now shorter than `from`. */
function scan(
  log: string,
  from: number,
  cap: number,
): { stop: number; big: { start: number; end: number } | null; more: boolean } {
  const fd = fs.openSync(log, "r")
  try {
    const size = fs.fstatSync(fd).size
    if (size < from) throw new RunLogChangedError("the run log is shorter than where it was read to")
    // Sized to what is there now, so a read of a small tail (each live chunk's) doesn't allocate a whole CHUNK.
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(64 << 10, size - from)))
    let pos = from
    let lineStart = from
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, pos)
      if (count === 0) return { stop: lineStart, big: null, more: false }
      const data = chunk.subarray(0, count)
      for (let nl = data.indexOf(0x0a); nl !== -1; nl = data.indexOf(0x0a, nl + 1)) {
        const lineEnd = pos + nl + 1
        if (lineEnd - lineStart > cap) return { stop: lineStart, big: { start: lineStart, end: lineEnd }, more: false }
        lineStart = lineEnd
      }
      pos += count
      if (lineStart > from && pos - from >= SCAN_WINDOW) return { stop: lineStart, big: null, more: true }
    }
  } finally {
    fs.closeSync(fd)
  }
}

/** Folds into `state` the records of the log `log` (of the run `runId`) after the last one it folded, until the end of
 *  its complete lines (true) or `deadline` (false). Each stretch of lines is scanned before yian's reader reads it, so
 *  a line over `cap` is never held or parsed (`foldBig`). */
function readOn(log: string, runId: string, state: Fold, cap: number, deadline: number): boolean {
  for (;;) {
    const { stop, big, more } = scan(log, state.end, cap)
    if (stop > state.end) {
      // Every kind is read, not only KINDS, so the read can stop at exactly the scanned end.
      const resume = state.seq === null ? {} : { afterOffset: state.end, runId: state.runId, afterSeq: state.seq }
      let reached = false
      for (const entry of iterRunRecords(log, resume)) {
        // A record past the scanned end means the scanned bytes were rewritten since.
        if (entry.end > stop) throw new RunLogChangedError("the run log changed under its read")
        if (KINDS.has(entry.kind)) fold(state, entry.seq, entry.at, entry.kind, entry.nodeId, entry.envelope.record)
        state.end = entry.end
        state.seq = entry.seq
        state.runId = entry.runId
        if (entry.end === stop) {
          reached = true
          break
        }
        if (performance.now() > deadline) return false
      }
      // The log ended before the scanned end: it was cut since; what is left is read next time.
      if (!reached) return true
    }
    if (big !== null) {
      if (state.runId === "") state.runId = runId
      foldBig(log, state, big.start, big.end)
    } else if (!more) {
      return true
    }
    if (performance.now() > deadline) return false
  }
}

/** The leading scalar fields of the JSON object whose members start `text`, and the text from the first member that
 *  isn't one (or past the object's end). */
function leading(text: string): { fields: Record<string, unknown>; rest: string } {
  const fields: Record<string, unknown> = {}
  let rest = text
  for (let match = PAIR.exec(rest); match !== null; match = PAIR.exec(rest)) {
    fields[match[1]!] = JSON.parse(match[2]!)
    rest = rest.slice(match[0].length)
    if (match[3] === "}") break
  }
  return { fields, rest }
}

/** Folds into `state` the line of `log` from `start` to `end`, over the line cap, from its first and last bytes only:
 *  a reply's `tool_result` step keeps its call and shows its size as its output, any other reply step shows its size,
 *  a commit's acceptance and a run's end count, and the rest is skipped. Throws a RangeError, naming the line by
 *  number only, when the line's seq isn't the next one. */
function foldBig(log: string, state: Fold, start: number, end: number): void {
  const size = end - start
  const seq = state.seq === null ? 0 : state.seq + 1
  const head = Buffer.alloc(Math.min(HEAD_BYTES, size))
  const tail = Buffer.alloc(Math.min(TAIL_BYTES, size))
  const fd = fs.openSync(log, "r")
  try {
    fs.readSync(fd, head, 0, head.length, start)
    fs.readSync(fd, tail, 0, tail.length, end - tail.length)
  } finally {
    fs.closeSync(fd)
  }
  if (SEQ.exec(tail.toString("latin1"))?.[1] !== String(seq)) {
    throw new RangeError(`run log line ${seq + 1} is too large to read and doesn't read as record ${seq}`)
  }
  const text = head.toString("utf8")
  const envelope = text.startsWith("{") ? leading(text.slice(1)) : { fields: {}, rest: "" }
  const at = typeof envelope.fields.at === "string" ? envelope.fields.at : ""
  const kind = envelope.fields.kind
  const payload = envelope.rest.startsWith('"payload":{') ? leading(envelope.rest.slice(11)) : { fields: {}, rest: "" }
  const nodeId = typeof payload.fields.node_id === "string" ? payload.fields.node_id : null
  if (kind === "node_step" && typeof payload.fields.n === "number" && payload.rest.startsWith('"step":{')) {
    const step = leading(payload.rest.slice(8)).fields
    const result = step.kind === "tool_result" && typeof step.call_id === "string"
    const closed = step.closed ?? null
    const output = tooLargeText(size)
    fold(state, seq, at, kind, nodeId, {
      n: payload.fields.n,
      step: result
        ? { kind: "tool_result", call_id: step.call_id, closed, is_error: step.is_error === true, output }
        : { kind: "too_large", size },
    })
  } else if (kind === "node_succeeded" && typeof payload.fields.commit === "number") {
    fold(state, seq, at, kind, nodeId, { commit: payload.fields.commit })
  } else if (kind === "run_cancelled" || kind === "run_failed") {
    fold(state, seq, at, kind, null, {})
  }
  state.end = end
  state.seq = seq
}

/** A copy of `value` sharing no memory with the line it was parsed from (JSC keeps a substring's parent string alive,
 *  so a kept slice would pin its whole line in the cache), charged to `state`. `value` holds no bigint. */
function keep<T>(state: Fold, value: T): T {
  state.held += 2 * JSON.stringify(value).length + OVERHEAD
  return structuredClone(value)
}

/** What the render reads of the step `step`, as plain JSON; null for a step it ignores. */
function slim(step: Step): Step | null {
  switch (step.kind) {
    case "model_call": {
      // Only a chat call that didn't fail shows its parts; any call takes its step number.
      const shown = step.purpose === "chat" && step.error == null
      const output = step.output as { parts?: Record<string, unknown>[] } | null
      const parts = (shown ? (output?.parts ?? []) : []).flatMap((part): Record<string, unknown>[] => {
        if (part.type === "text" || part.type === "refusal") return [{ type: part.type, text: part.text }]
        if (part.type !== "tool_call") return []
        // A call whose arguments didn't parse keeps null, which never shows.
        const args = isPlain(part.arguments) ? plain(part.arguments) : null
        return [{ type: "tool_call", id: part.id, name: part.name, arguments: args }]
      })
      return { kind: "model_call", purpose: shown ? "chat" : "other", error: null, output: { parts } }
    }
    case "tool_result":
      return {
        kind: "tool_result",
        call_id: step.call_id,
        closed: typeof step.closed === "string" ? step.closed : null,
        is_error: step.is_error === true,
        output: plain(step.output),
      }
    case "pending":
      return { kind: "pending", tool_call_id: step.tool_call_id }
    case "steer":
      return { kind: "steer", from: Array.isArray(step.from) ? step.from.map(Number) : [] }
    case "interrupted":
      return { kind: "interrupted" }
    case "too_large":
      return { kind: "too_large", size: step.size }
    default:
      return null
  }
}

/** Folds the log record `record` (seq `seq`, written at `at`, of kind `kind` by node `nodeId`) into `state`, keeping
 *  copies of only what the render reads. */
function fold(state: Fold, seq: number, at: string, kind: string, nodeId: string | null, record: unknown): void {
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
      // Its last text part is all that shows: earlier ones are the turn's context.
      const text = message.parts.findLast((part) => part.type === "text") as { text: string } | undefined
      const shown = { author: message.author, parts: text === undefined ? [] : [{ type: "text", text: text.text }] }
      state.sends.set(seq, keep(state, { seq, at, message: shown as Send["message"] }))
    } else if (record.take !== null && record.take.inbox === inbox && MAIN_CHAT.isTurn(record.nodeId)) {
      state.takes.set(seq, keep(state, record.take.events.map(Number)))
    }
  } else if (kind === "node_succeeded") {
    const commit = (record as { commit: number }).commit
    const take = state.takes.get(commit)
    if (take !== undefined) {
      state.takes.delete(commit)
      state.items.push({ kind: "take", events: take })
      for (const event of take) state.read.add(event)
    }
    if (reply !== null) state.settled.add(keep(state, reply))
  } else if (kind === "node_failed") {
    if (reply !== null) state.settled.add(keep(state, reply))
  } else if (kind === "node_started") {
    // A run resumed after a crash starts the reply again; its message opened at the first start.
    if (reply !== null && !state.started.has(reply)) {
      const node = keep(state, reply)
      state.started.add(node)
      state.items.push({ kind: "start", node, seq, at: keep(state, at) })
    }
  } else if (kind === "node_step") {
    const { n, step } = record as { n: number; step: Step }
    const kept = reply === null ? null : slim(step)
    if (reply !== null && kept !== null) {
      state.items.push(keep(state, { kind: "step", node: reply, n, seq, at, step: kept }))
      if (kept.kind === "steer") for (const event of kept.from as readonly number[]) state.read.add(event)
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
        // A call whose arguments didn't parse never runs, so it shows nothing and takes no index.
        parts
          .filter((part) => part.type === "tool_call" && isPlain(part.arguments))
          .forEach((call, i) => {
            const part: ToolPart = {
              id: `${runId}:${node}:${n}:${i}`,
              type: "tool",
              call_id: call.id as string,
              tool: call.name as string,
              state: "running",
              input: plain(call.arguments) as Record<string, unknown>,
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
        for (const event of step.from as readonly number[]) {
          const send = state.sends.get(event)
          if (send) out.push(userMessage(sessionId, runId, send))
        }
        if (open.has(node)) open.set(node, assistantMessage(sessionId, runId, item.seq, item.at))
      } else if (step.kind === "interrupted") {
        const tail = open.get(node)?.parts.at(-1)
        if (tail?.type === "text") tail.text += INTERRUPTED_TEXT
        else add(node, { id: `${runId}:${node}:${n}`, type: "text", text: INTERRUPTED_TEXT.trimStart() })
      } else if (step.kind === "too_large") {
        // A step whose line was too large to read: whatever it was, it shows its size where its text would be, and
        // takes its step number, so a live call on it doesn't show twice.
        called.add(`${node}:${n}`)
        calls.set(node, new Map())
        add(node, { id: `${runId}:${node}:${n}`, type: "text", text: tooLargeText(step.size as number) })
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
export function userMessage(sessionId: string, runId: string, send: Send): Message {
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

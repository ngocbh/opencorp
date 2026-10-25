/** A session's transcript: Message rows projected from its runs' logs. */
import path from "node:path"
import {
  checkMessage,
  iterRunRecords,
  type LiveViewCall,
  type Message as RunMessage,
  PoolCommitRecord,
  TypedValue,
} from "@ngocbh/yian/run"
import { Handle, type Message } from "@opencorp/protocol"
import { MAIN_CHAT } from "./turns.ts"

export { INTERRUPTED_TEXT } from "../harness/translate.ts"

/** The actor's view of its live runs: the model calls in flight of `runId`, or null when nothing runs it. */
export interface LiveCalls {
  calls(runId: string): readonly LiveViewCall[] | null
}

/** The run log records the transcript folds. */
const KINDS = ["pool_commit", "node_succeeded"]

/** A message sent to the chat's inbox: its send commit's seq and time, and the message. */
interface Send {
  seq: number
  at: string
  message: RunMessage
}

/** A turn whose take was accepted: the turn node and the send seqs its take consumed. */
interface Entry {
  turn: string
  events: readonly number[]
}

/** What one run's log has said so far, folded record by record. */
interface RunState {
  /** Every send, by seq, in seq order. */
  sends: Map<number, Send>
  /** The seqs of the sends an accepted take consumed. */
  read: Set<number>
  /** Take commits no success has accepted yet, by commit seq. */
  takes: Map<number, Entry>
  /** The accepted turns, in log order. */
  entries: Entry[]
}

/** True for a run id that names a folder directly under the runs folder. */
function safeRunId(runId: string): boolean {
  return runId !== "" && runId !== "." && runId !== ".." && !/[/\\\0]/.test(runId)
}

/** A user message's id: its send's run and seq, the seq padded so ids sort in log order. */
function messageId(runId: string, seq: number): string {
  return `${runId}:${String(seq).padStart(12, "0")}`
}

/** A session's transcript, read from its runs' logs (`<runs>/<run_id>/log.jsonl`). */
export class Transcript {
  readonly runs: string
  readonly maxBytes: number | undefined

  constructor(runs: string, options: { maxBytes?: number } = {}) {
    this.runs = runs
    this.maxBytes = options.maxBytes
  }

  /** The messages of the runs `runIds` (session_runs order), then the last run's queued messages. */
  messages(sessionId: string, runIds: readonly string[], live?: LiveCalls): Message[] {
    const out: Message[] = []
    runIds.forEach((runId, index) => {
      if (!safeRunId(runId)) return
      const state = this.read(runId)
      for (const entry of state.entries) {
        for (const seq of entry.events) {
          const send = state.sends.get(seq)
          if (send) out.push(userMessage(sessionId, runId, send))
        }
      }
      // A replaced run's unread sends were moved into the fresh run, so only the last run's are queued.
      if (index === runIds.length - 1) {
        for (const send of state.sends.values()) {
          if (!state.read.has(send.seq)) out.push(userMessage(sessionId, runId, send))
        }
      }
    })
    return out
  }

  /** Forgets the reads of `runIds`, for a session that ended. */
  forget(runIds: Iterable<string>): void {
    // Each call reads the whole logs, so nothing is kept to forget.
  }

  /** The state of the run `runId`, folded from its whole log; a run with no log yet has none. */
  private read(runId: string): RunState {
    const state: RunState = { sends: new Map(), read: new Set(), takes: new Map(), entries: [] }
    try {
      for (const entry of iterRunRecords(path.join(this.runs, runId, "log.jsonl"), { kinds: KINDS })) {
        fold(state, entry.seq, entry.at, entry.kind, entry.envelope.record)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    return state
  }
}

/** Folds the record `record` (of kind `kind`, at `seq` and `at`) into `state`. */
function fold(state: RunState, seq: number, at: string, kind: string, record: unknown): void {
  const inbox = MAIN_CHAT.inbox
  if (kind === "pool_commit" && record instanceof PoolCommitRecord) {
    if (record.value !== null && record.key === `${record.nodeId}.${inbox}`) {
      let message: RunMessage
      try {
        message = checkMessage(TypedValue.fromWire(record.value).toObject())
      } catch {
        return
      }
      state.sends.set(seq, { seq, at, message })
    } else if (record.take !== null && record.take.inbox === inbox && MAIN_CHAT.isTurn(record.nodeId)) {
      state.takes.set(seq, { turn: record.nodeId, events: record.take.events })
    }
  } else if (kind === "node_succeeded") {
    const { commit } = record as { nodeId: string; commit: number }
    const take = state.takes.get(commit)
    if (take === undefined) return
    state.takes.delete(commit)
    state.entries.push(take)
    for (const event of take.events) state.read.add(event)
  }
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

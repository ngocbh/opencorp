/** What a fresh chat run takes from the run it replaces, read from that run's yian run log. */
import {
  cancel,
  checkConversation,
  DeliveryRefused,
  type FoldedRun,
  foldRunLog,
  inspectRun,
  iterRunRecords,
  type Message,
  PoolCommitRecord,
  type RunLogEntry,
  TypedValue,
} from "@ngocbh/yian/run"
import { errorName } from "../worker/rpc.ts"
import { MAIN_CHAT } from "./turns.ts"

/** What a fresh run takes from the run it replaces. */
export interface Seeded {
  readonly summary: string
  /** The kept turns, one list of messages each; one trailing empty turn dropped. */
  readonly history: Message[][]
  /** The replaced run's sends no turn or steer read. */
  readonly unread: Message[]
  /** The type of the error that kept the history from being seeded; `null` when it was seeded. */
  readonly error: string | null
}

/** How the replaced run's log is read: under `env`, that run's environment, with CODE references confined to
 *  `codeRoot`. */
type SeedOptions = { env: (name: string) => string | undefined; codeRoot: string }

// yian's fixed START id: the commit under this key holds the run's inputs, and a send commits under
// `<START>.<inbox>`.
const START = "__start__"
const SEND_KEY = `${START}.${MAIN_CHAT.inbox}`
// A turn's end in the main chat's LOOP; nested ends such as `chat#3/context/compacted/__end__` don't match.
const TURN_END = new RegExp(`^${MAIN_CHAT.turn.split("/")[0]}#\\d+/__end__$`)

/**
 * The `summary` and `history` the run logged at `log` carried last: its last accepted turn end's, or, when it
 * finished no turn, its START inputs'; and its unread sends to the main chat's inbox. Never rejects: a failed fold
 * seeds `""` and `[]`, with the error's type in `error`, and still reads the unread sends from the records; a log
 * that can't be read moves none.
 */
export async function readSeed(log: string, options: SeedOptions): Promise<Seeded> {
  let entries: RunLogEntry[] | null = null
  let seeded: Omit<Seeded, "unread">
  try {
    const { records } = await foldRunLog(log, options)
    entries = records.map((record) => record.entry)
    seeded = { ...carried(records), error: null }
  } catch (error) {
    seeded = { summary: "", history: [], error: errorName(error) }
  }
  let unread: Message[] = []
  try {
    unread = unreadSends(entries ?? [...iterRunRecords(log)])
  } catch {
    // An unreadable log moves nothing; the fresh run starts all the same.
  }
  return { ...seeded, unread }
}

/** `readSeed`'s `summary` and `history`, from the folded `records`; throws what keeps them from being seeded. */
function carried(records: FoldedRun["records"]): { summary: string; history: Message[][] } {
  let start: unknown = null
  let end: unknown = null
  for (const { entry, value } of records) {
    const record = entry.envelope.record
    // An orphan commit's value is null: no success accepted it.
    if (value === null || !(record instanceof PoolCommitRecord)) continue
    if (TURN_END.test(record.key)) end = value.toObject()
    else if (record.key === START && start === null) start = value.toObject()
  }
  // A person's own main flow could type these fields otherwise; the chat lint checks only their names.
  const { summary, history } = (end ?? start ?? {}) as { summary?: unknown; history?: unknown }
  if (typeof summary !== "string" || !Array.isArray(history) || !history.every(Array.isArray)) {
    throw new TypeError("the carried summary or history has the wrong type")
  }
  const turns = history as Message[][]
  // A close with nothing queued appends an empty turn.
  const kept = turns.at(-1)?.length === 0 ? turns.slice(0, -1) : turns
  checkConversation(kept.flat())
  return { summary, history: kept }
}

/**
 * The sends to the main chat's inbox, in log order, that no accepted take and no steer step consumed. A take commit
 * counts once a success names it: an orphan one's events go back to unread, as yian re-offers them.
 */
function unreadSends(entries: readonly RunLogEntry[]): Message[] {
  const sends = new Map<number, Message>()
  const takes = new Map<number, readonly number[]>()
  const consumed = new Set<number>()
  for (const entry of entries) {
    const record = entry.envelope.record
    if (record instanceof PoolCommitRecord) {
      if (record.nodeId === START && record.key === SEND_KEY && record.value !== null) {
        sends.set(entry.seq, TypedValue.fromWire(record.value).toObject() as Message)
      } else if (record.take !== null) {
        takes.set(entry.seq, record.take.events)
      }
    } else if (entry.kind === "node_succeeded") {
      // yian doesn't export the success and step record classes, so their fields are read by the record's kind.
      const commit = (record as { commit?: unknown }).commit
      for (const seq of typeof commit === "number" ? (takes.get(commit) ?? []) : []) consumed.add(seq)
    } else if (entry.kind === "node_step") {
      const step = (record as { step?: Record<string, unknown> }).step
      if (step?.kind === "steer" && step.inbox === MAIN_CHAT.inbox && Array.isArray(step.from)) {
        // Step ints are bigints.
        for (const seq of step.from) consumed.add(Number(seq))
      }
    }
  }
  return [...sends].filter(([seq]) => !consumed.has(seq)).map(([, message]) => message)
}

/**
 * Cancels the run at `log` when it hasn't finished, under `env` with CODE references confined to `codeRoot`. Never
 * rejects: a cancel that fails writes one stderr line with the refusal's reason or the error's type, and the run is
 * left as it is.
 */
export async function cancelReplaced(log: string, { env, codeRoot }: SeedOptions): Promise<void> {
  try {
    const { status } = inspectRun(log)
    if (status === "running" || status === "waiting" || status === "stopped" || status === "crashed") {
      await cancel(log, { env, codeRoot })
    }
  } catch (error) {
    const why = error instanceof DeliveryRefused ? error.reason : errorName(error)
    process.stderr.write(`opencorp __worker: the replaced run was not cancelled (${why})\n`)
  }
}

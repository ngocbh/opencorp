/** A session's transcript: Message rows projected from its runs' logs. */
import fs from "node:fs"
import path from "node:path"
import {
  checkMessage,
  iterRunRecords,
  iterRunRecordsBackwards,
  type LiveViewCall,
  type Message as RunMessage,
  PoolCommitRecord,
  RunLogChangedError,
  type RunLogEntry,
  RunLogLineTooLongError,
  takeInboxes,
  TypedValue,
} from "@ngocbh/yian/run"
import { Handle, type Message, type Part, type ToolPart } from "@opencorp/protocol"
import { INTERRUPTED_TEXT } from "../../tools/codex/translate.ts"
import { CHUNK, HUGE_LINE } from "../../runtime/runs/reader.ts"
import { errorName } from "../../runtime/worker/rpc.ts"
import { actionOnly, MAIN_CHAT } from "../../company/chat_flow.ts"

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
  "inbox_withdrawn",
])

/** The longest log line the transcript parses (Run Logs' HUGE_LINE): yian's reader holds a line whole, and parsing it
 *  takes several times its size, so a longer one is read by its first and last bytes only. */
export const LINE_CAP = HUGE_LINE
/** About how many bytes past a fold's end one scan looks at before yian's reader reads them. */
const SCAN_WINDOW = 8 * CHUNK
/** The most bytes a read from a log's end scans back for a rest point (`restBefore`) before it reads the run whole. */
const TAIL_SCAN = 2 * CHUNK
/** A log of at most this many bytes is read whole: a page of it read from its end would read most of it twice. */
const SMALL_LOG = CHUNK / 4
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

/** A message sent to the chat's inbox or its queue: its send commit's seq and time, what the transcript shows of it,
 *  the key the office sent it under, if any, whether it went to the queue, and the person who sent it (`by`), if its
 *  record names one. */
interface Send {
  seq: number
  at: string
  message: Pick<RunMessage, "author" | "parts">
  key?: string | null
  queued?: boolean
  by?: string | null
}

/** The key of an instrument's note, as the office sends it: the shell's or the Codex or Claude Code session's id, the
 *  command's or turn's number there, then, for a note sent again, more. Only the office sends under a key, so it marks
 *  the note as the instrument's. */
const NOTE_KEY = /^(?:terminal|codex|claude):([0-9A-HJKMNP-TV-Z]{26}):\d+(?::|$)/

/** A step a node recorded: as the log holds it (ints as bigints) when folded, then the copy `slim` keeps. */
type Step = Readonly<Record<string, unknown>>

/** What the render walks, in log order: an accepted take (the send seqs it consumed), a reply's first start, and a
 *  reply's step. */
type Item =
  | { kind: "take"; events: readonly number[] }
  | { kind: "start"; node: string; seq: number; at: string }
  | { kind: "step"; node: string; n: number; seq: number; at: string; step: Step }

/**
 * A rest point of a run's log: a `run_waiting` record whose only waiting node is a turn whose take of the chat's inbox
 * and queue waits (its `node_waiting` is the record just before). Yian lets a take wait only while the inboxes it reads
 * hold no unread send, and settles every other node first, so at a rest point no reply is at work and every send
 * before it has been read or withdrawn. What the transcript shows after a rest point is thus folded from the records
 * after it alone. A rest point is named by its line's start (`offset`) and end, its seq and its run id.
 */
interface Rest {
  offset: number
  end: number
  seq: number
  runId: string
}

/** What one run's log has said so far, folded record by record: the whole log, or a segment of it that starts after
 *  a rest point. */
interface Fold {
  /** Every send, by seq, in seq order. */
  sends: Map<number, Send>
  /** The seqs of the sends an accepted take consumed. */
  read: Set<number>
  /** The keys of every send to the chat's inbox or its queue that was sent under one. */
  keys: Set<string>
  /** The sends a withdraw took back, by seq: whether each had gone to the queue, and who sent it. */
  withdrawn: Map<number, { queued: boolean; by: string | null }>
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
  /** The rest point the fold starts after; null for a fold from the log's start. */
  from: Rest | null
  /** Whether a record named something before the fold's start that a fold from a rest point never meets (a send a
   *  take, a steer or a withdraw names, a take a turn's success accepts, or the start of a reply it has a record of):
   *  then the run is read whole. */
  undecided: boolean
}

/** A fold of no record yet, from the log's start or after the rest point `from`. */
function emptyFold(from: Rest | null = null): Fold {
  return {
    sends: new Map(),
    read: new Set(),
    keys: new Set(),
    withdrawn: new Map(),
    takes: new Map(),
    items: [],
    started: new Set(),
    settled: new Set(),
    ended: false,
    end: from?.end ?? 0,
    seq: from?.seq ?? null,
    runId: from?.runId ?? "",
    held: 0,
    from,
    undecided: false,
  }
}

/** The first seq a run's read in `segments` (oldest first) covers: 0 when it reads the log from its start. */
function firstSeq(segments: readonly Fold[]): number {
  const from = segments[0]!.from
  return from === null ? 0 : from.seq + 1
}

/** The send at `seq` that one of `segments` holds. */
function sendIn(segments: readonly Fold[], seq: number): Send | undefined {
  for (const segment of segments) {
    const send = segment.sends.get(seq)
    if (send !== undefined) return send
  }
  return undefined
}

/** Whether a take or a steer in one of `segments` read the send at `seq`. */
function readIn(segments: readonly Fold[], seq: number): boolean {
  return segments.some((segment) => segment.read.has(seq))
}

/** True for a run id that names a folder directly under the runs folder. */
function safeRunId(runId: string): boolean {
  return runId !== "" && runId !== "." && runId !== ".." && !/[/\\\0]/.test(runId)
}

/** A message's id: its run and the seq of the record that opens it, the seq padded so ids sort in log order. */
export function messageId(runId: string, seq: number): string {
  return `${runId}:${String(seq).padStart(12, "0")}`
}

/** The seq in the id of a message of the run `runId` (`messageId`), or null for an id of no message of that run. */
function seqOf(id: string, runId: string): number | null {
  const at = id.lastIndexOf(":")
  if (id.slice(0, at) !== runId || !/^[0-9]{1,15}$/.test(id.slice(at + 1))) return null
  return Number(id.slice(at + 1))
}

/** A page of a session's messages, oldest first, and `next`: the id of its first message when older ones come before
 *  it (the next, older page ends before it), else null. */
export interface TranscriptPage {
  messages: Message[]
  next: string | null
}

/** The page of the newest `limit` of `messages` (a whole transcript) before the message `before` names, or the
 *  newest of all; null when no message has that id. */
export function pageOf(messages: readonly Message[], limit: number, before: string | null): TranscriptPage | null {
  const end = before === null ? messages.length : messages.findIndex((m) => m.id === before)
  if (end < 0) return null
  const start = Math.max(0, end - limit)
  return { messages: messages.slice(start, end), next: start > 0 ? messages[start]!.id : null }
}

/** The kinds of warning a run's transcript logs once each: an unopenable log, a line that stops the read. */
const WARNINGS = ["eacces", "stops"] as const

/** How many warnings the transcript remembers before it forgets them all, so a long-lived office stays bounded. */
const WARNED_CAP = 10_000

/**
 * A session's transcript, read from its runs' logs (`<runs>/<run_id>/log.jsonl`). Each run's read is cached, least
 * recently read first, and each read folds only what its log added since; the cache keeps reads holding at most
 * `maxBytes` (32 MiB by default), and always the run just read. A fold keeps copies of only what it shows, so a large
 * log whose transcript is small stays cached. A log line over `lineCap` (LINE_CAP by default) is never parsed: a reply
 * step shows its size instead.
 *
 * A run is read whole, from its log's start, or from its end (`page`, `recent`): back to its newest rest point
 * (`Rest`), then forward from there, then back one rest point at a time while more is wanted. Each segment between
 * two rest points is folded alone, and what they show together is what a whole read shows. A read from the end
 * becomes a whole read when no rest point lies within `tailScan` bytes (TAIL_SCAN by default) of where it reads back
 * from, when a record after a rest point names something before it (`Fold.undecided`), when the log changed under it
 * (`RunLogChangedError`), and when it meets a line it can't read; and, as that costs less, for a log of at most
 * `smallLog` bytes (SMALL_LOG by default), and once what is left before it is at most half the log (unless
 * `wholePastHalf` is false).
 *
 * A log line that isn't a record this version reads stops its run's transcript after the record before it: each later
 * read stops there again, and `log` gets one line for the run, naming the record and the error's type, never the
 * line. A read from the end checks only the lines it reads; once a page reads back to such a line, the run is read
 * whole, which stops there, so the newest page shows what that read shows and an older page's cursor names no message
 * (`bad_cursor`), as the run's restore and its Run Logs, which read from the start, show the damage. A run whose log
 * or folder isn't there shows no messages; one whose log can't be opened (`EACCES`) shows none either, logged once.
 */
export class Transcript {
  private readonly runs: string
  private readonly maxBytes: number
  private readonly lineCap: number
  private readonly log: (line: string) => void
  private readonly tailScan: number
  private readonly smallLog: number
  private readonly wholePastHalf: boolean
  /** Each run's read, its segments oldest first: one from the log's start for a whole read. */
  private readonly cache = new Map<string, Fold[]>()
  private readonly refreshing = new Map<string, Promise<void>>()
  /** The warnings logged, by kind and run (`stops:<run_id>`), cleared at `WARNED_CAP`. */
  private readonly warned = new Set<string>()

  constructor(
    runs: string,
    options: {
      maxBytes?: number
      lineCap?: number
      log?: (line: string) => void
      tailScan?: number
      smallLog?: number
      wholePastHalf?: boolean
    } = {},
  ) {
    this.runs = runs
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024
    this.lineCap = options.lineCap ?? LINE_CAP
    this.log = options.log ?? (() => {})
    this.tailScan = options.tailScan ?? TAIL_SCAN
    this.smallLog = options.smallLog ?? SMALL_LOG
    this.wholePastHalf = options.wholePastHalf ?? true
  }

  /** The messages of the runs `runIds` (session_runs order), then the last run's unread sends, steers and queued. */
  messages(sessionId: string, runIds: readonly string[], live?: LiveCalls): Message[] {
    const out: Message[] = []
    runIds.forEach((runId, index) => {
      if (!safeRunId(runId)) return
      const last = index === runIds.length - 1
      renderRun(out, sessionId, runId, this.read(runId), last ? (live?.calls(runId) ?? null) : null, last)
    })
    return out
  }

  /**
   * The page of the messages of the runs `runIds` that `pageOf` cuts from `messages(sessionId, runIds, live)`: the
   * newest `limit` before the message `before` names, or the newest of all; null when no message has that id. The
   * runs are read from their logs' ends, newest run first, only until the page is full. A run that must be read whole
   * is read in slices that yield to the event loop (`refresh`), then the page is read again.
   */
  async page(
    sessionId: string,
    runIds: readonly string[],
    { limit, before = null }: { limit: number; before?: string | null },
    live?: LiveCalls,
  ): Promise<TranscriptPage | null> {
    for (let tries = 0; ; tries++) {
      // Past one wait per run, a run read whole meanwhile was dropped from the cache again: read it now.
      const page = this.pageOf(sessionId, runIds, limit, before, live, tries > runIds.length)
      if (page === null || !("whole" in page)) return page
      await this.refresh([page.whole])
    }
  }

  /** `page`'s page, read at once: a run that must be read whole is read so without a break. */
  pageNow(
    sessionId: string,
    runIds: readonly string[],
    { limit, before = null }: { limit: number; before?: string | null },
    live?: LiveCalls,
  ): TranscriptPage | null {
    return this.pageOf(sessionId, runIds, limit, before, live, true) as TranscriptPage | null
  }

  /**
   * The newest messages of the run `runId` as `messages(sessionId, [runId], live)` gives them, read from its log's end:
   * from at least one assistant message on, and every message whose id is one of `covering`, when the run has them.
   */
  recent(sessionId: string, runId: string, live?: LiveCalls, covering: Iterable<string> = []): Message[] {
    if (!safeRunId(runId)) return []
    let since = Infinity
    for (const id of covering) since = Math.min(since, seqOf(id, runId) ?? Infinity)
    const enough = (messages: Message[], first: number) =>
      first <= since && messages.some((message) => message.role === "assistant")
    return this.newest(sessionId, runId, true, live, enough, true)!.messages
  }

  /** The send at `seq` of the run `runId`, read on from its log: the inbox it went to (the chat's or its queue), the
   *  person who sent it (`by`, null when its record names none, as an instrument's note), and whether it waits there
   *  `unread`, a take or a steer has `read` it, or a withdraw took it back (`withdrawn`); null when the log holds no
   *  such send. */
  send(
    runId: string,
    seq: number,
  ): { inbox: string; by: string | null; state: "unread" | "read" | "withdrawn" } | null {
    if (!safeRunId(runId)) return null
    const read = this.covering(runId, seq)
    const inboxOf = (queued: boolean) => (queued ? MAIN_CHAT.queue : MAIN_CHAT.inbox)
    const withdrawn = read.find((segment) => segment.withdrawn.has(seq))?.withdrawn.get(seq)
    if (withdrawn !== undefined) return { inbox: inboxOf(withdrawn.queued), by: withdrawn.by, state: "withdrawn" }
    const send = sendIn(read, seq)
    if (send === undefined) return null
    const state = readIn(read, seq) ? "read" : "unread"
    return { inbox: inboxOf(send.queued === true), by: send.by ?? null, state }
  }

  /** The message of send `seq` of the run `runId`'s inbox `inbox` as the run held it, and the person whose withdraw
   *  named it and took it back (`by`, null when that withdraw named no person), read from its log; null when no such
   *  withdraw took it, or the log can't be read. */
  withdrawn(runId: string, inbox: string, seq: number): { message: RunMessage; by: string | null } | null {
    if (!safeRunId(runId)) return null
    try {
      const log = path.join(this.runs, runId, "log.jsonl")
      const send = withdrawnSends(log, inbox, { named: true }).find((taken) => taken.seq === seq)
      return send === undefined ? null : { message: send.message, by: send.takenBy }
    } catch (error) {
      this.log(`run ${runId}: a withdraw's sends can't be read (${errorName(error)})`)
      return null
    }
  }

  /** Whether the run `runId`'s log holds a send under `key`, read on from it: the office's keyed sends, such as a
   *  move's. */
  keyed(runId: string, key: string): boolean {
    if (!safeRunId(runId)) return false
    return this.read(runId).some((segment) => segment.keys.has(key))
  }

  /** Whether the send at `seq` of the run `runId` waits unread in its inbox (its log holds it, no take or steer has
   *  read it, and no withdraw took it back), read on from the run's cached read, whole or from its end; null when
   *  none is cached, so a caller that must stay cheap never reads a whole log. */
  unread(runId: string, seq: number): boolean | null {
    if (!safeRunId(runId) || !this.cache.has(runId)) return null
    const read = this.slice(runId, Infinity, "cached").read
    if (read === null) return null
    // A read from the end holds every send still unread: none before a rest point is.
    return sendIn(read, seq) !== undefined && !readIn(read, seq)
  }

  /** The user message of the send at `seq` of the run `runId` (session `sessionId`'s), unread or not as its log says;
   *  null when its log holds no such send. */
  sentMessage(sessionId: string, runId: string, seq: number): Message | null {
    if (!safeRunId(runId)) return null
    const read = this.covering(runId, seq)
    const send = sendIn(read, seq)
    return send === undefined ? null : userMessage(sessionId, runId, send, !readIn(read, seq))
  }

  /** The id of the first message of the reply still running in the run `runId` (its last reply, if it started, hasn't
   *  succeeded or failed, and the run wasn't cancelled or failed), or null. */
  runningReply(runId: string): string | null {
    if (!safeRunId(runId)) return null
    const read = this.read(runId)
    const items = read.flatMap((segment) => segment.items)
    const start = items.findLast((item) => item.kind === "start")
    if (read.some((segment) => segment.ended) || start === undefined) return null
    if (read.some((segment) => segment.settled.has(start.node))) return null
    return messageId(runId, start.seq)
  }

  /** Reads the logs of the runs `runIds` on, about SLICE_MS at a time with the event loop served in between, so the
   *  synchronous reads after it (`messages`, `runningReply`) read only what was added since: whole, or with `cached`,
   *  only a run whose read is cached, whole or from its end. Calls made while a run's refresh runs share it. A run's
   *  refresh stops early once its read leaves the cache (forgotten, or evicted). Rejects as `messages` throws for a log
   *  it can't read. */
  async refresh(runIds: readonly string[], { cached = false }: { cached?: boolean } = {}): Promise<void> {
    const mode = cached ? "cached" : "whole"
    for (const runId of runIds) {
      if (!safeRunId(runId) || (cached && !this.cache.has(runId))) continue
      const key = `${mode}:${runId}`
      let running = this.refreshing.get(key)
      if (running === undefined) {
        running = this.refreshRun(runId, mode).finally(() => this.refreshing.delete(key))
        this.refreshing.set(key, running)
      }
      await running
    }
  }

  /** Forgets the reads of `runIds`, for a session that ended. */
  forget(runIds: Iterable<string>): void {
    for (const runId of runIds) {
      this.cache.delete(runId)
      for (const kind of WARNINGS) this.warned.delete(`${kind}:${runId}`)
    }
  }

  private async refreshRun(runId: string, mode: "whole" | "cached"): Promise<void> {
    for (;;) {
      const { read, done } = this.slice(runId, performance.now() + SLICE_MS, mode)
      if (done || read === null) return
      await new Promise((resolve) => setImmediate(resolve))
      if (!this.cache.has(runId)) return
    }
  }

  /** `page`'s page; with `whole`, a run that must be read whole is read so, else the run is named (`whole`). */
  private pageOf(
    sessionId: string,
    runIds: readonly string[],
    limit: number,
    before: string | null,
    live: LiveCalls | undefined,
    whole: boolean,
  ): TranscriptPage | null | { whole: string } {
    // One more than the page, to tell whether older messages come before it.
    const want = limit + 1
    let index = runIds.length - 1
    let cursor: number | null = null
    if (before !== null) {
      // A message's id names its run, and only that run's read shows it.
      index = runIds.findIndex((runId) => seqOf(before, runId) !== null)
      if (index < 0) return null
      cursor = seqOf(before, runIds[index]!)
    }
    const older: Message[] = []
    for (let i = index; i >= 0 && older.length < want; i--) {
      const runId = runIds[i]!
      if (!safeRunId(runId)) {
        if (i === index && cursor !== null) return null
        continue
      }
      const last = i === runIds.length - 1
      const atCursor = i === index && cursor !== null
      const need = want - older.length
      // A read from the end shows every message whose id's seq is `first` or later, so a cursor at or past it that the
      // read doesn't show names no message.
      const enough = (messages: Message[], first: number) => {
        if (!atCursor) return messages.length >= need
        const end = messages.findIndex((m) => m.id === before)
        return end >= need || (end < 0 && cursor! >= first)
      }
      const read = this.newest(sessionId, runId, last, live, enough, whole)
      if (read === null) return { whole: runId }
      const end = atCursor ? read.messages.findIndex((m) => m.id === before) : read.messages.length
      if (end < 0) return null
      older.unshift(...read.messages.slice(Math.max(0, end - need), end))
    }
    const messages = older.slice(-limit)
    return { messages, next: older.length > limit ? messages[0]!.id : null }
  }

  /**
   * The newest messages of the run `runId` (the session's last run when `last`), as a whole read renders them, read
   * from its log's end back one rest point at a time until `enough` (given them and the first seq the read covers)
   * says so or the read reaches the log's start (`first` 0). Null, without `whole`, when the run must be read whole
   * first.
   */
  private newest(
    sessionId: string,
    runId: string,
    last: boolean,
    live: LiveCalls | undefined,
    enough: (messages: Message[], first: number) => boolean,
    whole: boolean,
  ): { messages: Message[]; first: number } | null {
    for (let read = this.tail(runId, whole); read !== null; read = this.extend(runId, whole)) {
      const messages: Message[] = []
      renderRun(messages, sessionId, runId, read, last ? (live?.calls(runId) ?? null) : null, last)
      const first = firstSeq(read)
      if (first === 0 || enough(messages, first)) return { messages, first }
    }
    return null
  }

  /** The cached read of the run `runId`, read on, else a read of its newest records from its newest rest point on
   *  (`restBefore`), cached; else a whole read: of a small log (`smallLog`) or one that isn't there always, and of any
   *  other only with `whole` (null without). */
  private tail(runId: string, whole: boolean): Fold[] | null {
    const cached = this.slice(runId, Infinity, "cached").read
    if (cached !== null) return cached
    const log = path.join(this.runs, runId, "log.jsonl")
    let rest: Rest | "start" | null
    try {
      if (fs.statSync(log).size <= this.smallLog) return this.read(runId)
      rest = restBefore(log, null, this.lineCap, this.tailScan)
    } catch (error) {
      // A whole read says what is wrong, as it does without this: at once for a system error, such as a missing log.
      if (typeof (error as NodeJS.ErrnoException | null)?.code === "string") return this.read(runId)
      rest = null
    }
    if (rest !== null && rest !== "start") {
      this.cache.set(runId, [emptyFold(rest)])
      const read = this.slice(runId, Infinity, "cached").read
      if (read !== null) return read
    }
    return whole ? this.read(runId) : null
  }

  /** The cached read of the run `runId` read on, with one more segment before it: back to the rest point before its
   *  oldest, or the log's start; the read as it is when it reads from the log's start already. Else as `tail`. */
  private extend(runId: string, whole: boolean): Fold[] | null {
    const read = this.slice(runId, Infinity, "cached").read
    if (read === null) return this.tail(runId, whole)
    const oldest = read[0]!.from
    if (oldest === null) return read
    const log = path.join(this.runs, runId, "log.jsonl")
    let rest: Rest | "start" | null = null
    try {
      // Once what is left before the read is at most half the log, one read of the whole costs less than reading the
      // rest back and on.
      if (!this.wholePastHalf || 2 * oldest.offset > fs.statSync(log).size) {
        rest = restBefore(log, oldest, this.lineCap, this.tailScan)
      }
    } catch {
      rest = null
    }
    if (rest !== null) {
      const segment = emptyFold(rest === "start" ? null : rest)
      if (foldSegment(log, runId, segment, this.lineCap, oldest.end)) {
        this.cache.delete(runId)
        read.unshift(segment)
        this.cache.set(runId, read)
        this.evict(runId)
        return read
      }
    }
    return whole ? this.read(runId) : null
  }

  /** The cached read of the run `runId` read on when it covers the record at `seq` (a send there, and whatever read or
   *  withdrew it, comes after), else its whole read. */
  private covering(runId: string, seq: number): Fold[] {
    const cached = this.slice(runId, Infinity, "cached").read
    return cached !== null && seq >= firstSeq(cached) ? cached : this.read(runId)
  }

  /** The whole read of the run `runId`, read on to the end of its log, or to the last record before a line that
   *  can't be read; a run with no log yet, or a log that can't be opened, reads as nothing, not cached. */
  private read(runId: string): Fold[] {
    return this.slice(runId, Infinity, "whole").read!
  }

  /**
   * The read of the run `runId`, its cached read read on until its log's end or the last record before a line that
   * can't be read (`done`), or `deadline` (a `performance.now()` time). `whole` reads the log from its start unless
   * the cached read does; `cached` reads on only a cached read, whole or from the end, and gives null for none. A read
   * from the end that the log no longer continues, that meets a line it can't read or that can't decide what it shows
   * (`Fold.undecided`) is dropped, and gives null. A run with no log yet, or a log that can't be opened, reads as
   * nothing, not cached.
   */
  private slice(runId: string, deadline: number, mode: "whole" | "cached"): { read: Fold[] | null; done: boolean } {
    const log = path.join(this.runs, runId, "log.jsonl")
    let cached = this.cache.get(runId)
    if (mode === "whole" && cached !== undefined && cached[0]!.from !== null) cached = undefined
    if (cached === undefined && mode === "cached") return { read: null, done: true }
    // Out of the cache while it is read, so a read that throws leaves no half-read fold, and put back last.
    this.cache.delete(runId)
    const fromEnd = cached !== undefined && cached[0]!.from !== null
    let read = cached ?? [emptyFold()]
    let state = read.at(-1)!
    let end: ReadEnd
    try {
      try {
        end = readOn(log, runId, state, this.lineCap, deadline)
      } catch (error) {
        if (!(error instanceof RunLogChangedError)) throw error
        if (fromEnd) return { read: null, done: true }
        read = [emptyFold()]
        state = read[0]!
        end = readOn(log, runId, state, this.lineCap, deadline)
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === "ENOENT" || code === "ENOTDIR") return { read: [emptyFold()], done: true }
      if (code !== "EACCES") throw error
      this.warnOnce("eacces", runId, `run ${runId}: its log can't be read (EACCES); it shows no messages`)
      return { read: [emptyFold()], done: true }
    }
    if (fromEnd && (end.stopped !== null || state.undecided)) return { read: null, done: true }
    if (end.stopped !== null) {
      // Only the record count and the error's type: yian's message quotes the log's path and the line's values.
      const where = state.seq === null ? "before its first record" : `after record ${state.seq}`
      const why = `${errorName(end.stopped)}: a line of its log can't be read`
      this.warnOnce("stops", runId, `run ${runId}: the transcript stops ${where} (${why})`)
    }
    this.cache.set(runId, read)
    this.evict(runId)
    return { read, done: end.done }
  }

  /** Drops the least recently read runs but `keep` until what the cache holds fits `maxBytes`. */
  private evict(keep: string): void {
    let bytes = 0
    for (const read of this.cache.values()) for (const fold of read) bytes += fold.held
    for (const [id, read] of this.cache) {
      if (bytes <= this.maxBytes) break
      if (id === keep) continue
      this.cache.delete(id)
      for (const fold of read) bytes -= fold.held
    }
  }

  /** Logs `line` unless a warning of `kind` was logged for the run `runId` already. */
  private warnOnce(kind: (typeof WARNINGS)[number], runId: string, line: string): void {
    const key = `${kind}:${runId}`
    if (this.warned.has(key)) return
    if (this.warned.size >= WARNED_CAP) this.warned.clear()
    this.warned.add(key)
    this.log(line)
  }
}

/**
 * The newest rest point (`Rest`) of the run log `log` before the record `before` (its end when null), read back with
 * no payload but the candidates', at most `maxBytes` bytes back; "start" when the read reaches the log's start
 * first, and null when it reads `maxBytes` first or meets a line over `cap` whose seq it can't tell.
 *
 * @throws the errors of yian's backward reader, `RunLogChangedError` among them.
 */
function restBefore(log: string, before: Rest | null, cap: number, maxBytes: number): Rest | "start" | null {
  let cursor = before === null ? {} : { beforeOffset: before.offset, beforeSeq: before.seq, runId: before.runId }
  let top = before?.offset ?? null
  // The record after (newer than) the one read, which is a rest point when it waits and the one read is its wait.
  let newer: Rest & { kind: string } | null = null
  for (;;) {
    try {
      for (const entry of iterRunRecordsBackwards(log, { ...cursor, payloads: false, maxLineBytes: cap })) {
        top ??= entry.end
        if (top - entry.offset > maxBytes) return null
        if (newer?.kind === "run_waiting" && entry.kind === "node_waiting" && MAIN_CHAT.isTurn(entry.nodeId)
          && isRest(log, entry, cap)) {
          return { offset: newer.offset, end: newer.end, seq: newer.seq, runId: newer.runId }
        }
        newer = { kind: entry.kind, offset: entry.offset, end: entry.end, seq: entry.seq, runId: entry.runId }
      }
      return "start"
    } catch (error) {
      if (!(error instanceof RunLogLineTooLongError) || error.seq === null || error.runId === null) throw error
      // A line over the cap is no rest point, nor its wait: read on back past it.
      top ??= error.end
      if (top - error.offset > maxBytes) return null
      newer = null
      cursor = { beforeOffset: error.offset, beforeSeq: error.seq, runId: error.runId }
    }
  }
}

/** Whether the `node_waiting` record `waiting` of the log `log` and the record after it make a rest point: the wait is
 *  a take of the chat's inbox and its queue, and the record after it a `run_waiting` of that node alone. */
function isRest(log: string, waiting: RunLogEntry<null>, cap: number): boolean {
  const resume = { afterOffset: waiting.offset, runId: waiting.runId, afterSeq: waiting.seq - 1, maxLineBytes: cap }
  const records = iterRunRecords(log, resume)
  try {
    const wait = records.next().value?.envelope.record as { waits?: readonly { tool?: string; inbox?: unknown }[] }
    const rest = records.next().value?.envelope.record as { nodeIds?: readonly string[] }
    const take = wait?.waits?.length === 1 ? wait.waits[0]! : null
    if (take?.tool !== "take" || (typeof take.inbox !== "string" && !Array.isArray(take.inbox))) return false
    const inboxes = takeInboxes(take.inbox as string | string[])
    if (!inboxes.includes(MAIN_CHAT.inbox) || !inboxes.includes(MAIN_CHAT.queue)) return false
    return rest?.nodeIds?.length === 1 && rest.nodeIds[0] === waiting.nodeId
  } finally {
    records.return()
  }
}

/** Folds into `segment` the records of the log `log` (of the run `runId`) from its start to the byte `limit`, where
 *  the segment after it starts; whether it read all of them and what they show stands alone (no record named
 *  something before the segment, and every send in it was read or withdrawn in it). */
function foldSegment(log: string, runId: string, segment: Fold, cap: number, limit: number): boolean {
  try {
    const end = readOn(log, runId, segment, cap, Infinity, limit)
    if (end.stopped !== null || segment.end !== limit || segment.undecided) return false
  } catch {
    return false
  }
  return [...segment.sends.keys()].every((seq) => segment.read.has(seq))
}

/** Where a read of a log ended: at the end of its complete lines or at a line that isn't a record this version reads
 *  (`done`), or at its deadline; `stopped` is that line's error, else null. */
interface ReadEnd {
  done: boolean
  stopped: unknown
}

/** Where a read of `log` from `from` stops (`stop`): the end of the last complete line scanned, CHUNK at a time for
 *  newlines only, before the first line over `cap` (`big`, its start and end, or null), and at `limit` at the latest.
 *  `more` says the scan stopped after about SCAN_WINDOW bytes with more to scan. A line over `cap` with no newline yet
 *  stops the scan before it. Throws RunLogChangedError when the log is now shorter than `from` or a finite `limit`. */
function scan(
  log: string,
  from: number,
  cap: number,
  limit = Infinity,
): { stop: number; big: { start: number; end: number } | null; more: boolean } {
  const fd = fs.openSync(log, "r")
  try {
    const size = fs.fstatSync(fd).size
    if (size < from || (limit !== Infinity && size < limit)) {
      throw new RunLogChangedError("the run log is shorter than where it was read to")
    }
    const top = Math.min(size, limit)
    // Sized to what is there now, so a read of a small tail (each live chunk's) doesn't allocate a whole CHUNK.
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(64 << 10, top - from)))
    let pos = from
    let lineStart = from
    for (;;) {
      const count = pos >= limit ? 0 : fs.readSync(fd, chunk, 0, Math.min(chunk.length, limit - pos), pos)
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

/**
 * Folds into `state` the records of the log `log` (of the run `runId`) after the last one it folded, until the end of
 * its complete lines or the byte `limit`, a line that isn't a record this version reads (a `RangeError`,
 * `RunLogSchemaError` among them, with `state` folded up to the record before it), or `deadline`. Each stretch of
 * lines is scanned before yian's reader reads it, so a line over `cap` is never held or parsed (`foldBig`).
 *
 * @throws RunLogChangedError when the log no longer continues `state`; the error of a failed open or read.
 */
function readOn(log: string, runId: string, state: Fold, cap: number, deadline: number, limit = Infinity): ReadEnd {
  for (;;) {
    const { stop, big, more } = scan(log, state.end, cap, limit)
    if (stop > state.end) {
      // Every kind is read, not only KINDS, so the read can stop at exactly the scanned end.
      const resume = state.seq === null ? {} : { afterOffset: state.end, runId: state.runId, afterSeq: state.seq }
      const records = iterRunRecords(log, resume)
      try {
        for (;;) {
          let next: IteratorResult<RunLogEntry, void>
          try {
            next = records.next()
          } catch (error) {
            if (!(error instanceof RangeError) || error instanceof RunLogChangedError) throw error
            return { done: true, stopped: error }
          }
          // The log ended before the scanned end: it was cut since; what is left is read next time.
          if (next.done) return { done: true, stopped: null }
          const entry = next.value
          // A record past the scanned end means the scanned bytes were rewritten since.
          if (entry.end > stop) throw new RunLogChangedError("the run log changed under its read")
          // A throw from the fold isn't caught: it would leave the record half folded, and a cached half fold would
          // fold it again on the next read.
          if (KINDS.has(entry.kind)) fold(state, entry.seq, entry.at, entry.kind, entry.nodeId, entry.envelope.record)
          state.end = entry.end
          state.seq = entry.seq
          state.runId = entry.runId
          if (entry.end === stop) break
          if (performance.now() > deadline) return { done: false, stopped: null }
        }
      } finally {
        // Closes the log when the read stops early or the fold throws.
        records.return()
      }
    }
    if (big !== null) {
      if (state.runId === "") state.runId = runId
      const stopped = foldBig(log, state, big.start, big.end)
      if (stopped !== null) return { done: true, stopped }
    } else if (!more) {
      return { done: true, stopped: null }
    }
    if (performance.now() > deadline) return { done: false, stopped: null }
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
 *  a commit's acceptance and a run's end count, and the rest is skipped; returns null. Returns a RangeError, naming the
 *  line by number only, and folds nothing, when the line's seq isn't the next one. */
function foldBig(log: string, state: Fold, start: number, end: number): RangeError | null {
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
    return new RangeError(`run log line ${seq + 1} is too large to read and doesn't read as record ${seq}`)
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
  return null
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
      return { kind: "pending", tool_call_id: step.tool_call_id, call_id: step.call_id }
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
 *  copies of only what the render reads. A fold from a rest point marks itself `undecided` at a record that names
 *  something before its start. */
function fold(state: Fold, seq: number, at: string, kind: string, nodeId: string | null, record: unknown): void {
  const { inbox, queue } = MAIN_CHAT
  const reply = MAIN_CHAT.isReply(nodeId) ? nodeId! : null
  const first = state.from === null ? 0 : state.from.seq + 1
  const before = (events: readonly (number | bigint)[]) => events.some((event) => Number(event) < first)
  // A reply's record whose start the fold hasn't read: the reply started before the fold's rest point.
  if (state.from !== null && reply !== null && kind !== "node_started" && !state.started.has(reply)) {
    state.undecided = true
  }
  if (kind === "pool_commit" && record instanceof PoolCommitRecord) {
    const queued = record.key === `${record.nodeId}.${queue}`
    if (record.value !== null && (queued || record.key === `${record.nodeId}.${inbox}`)) {
      let message: RunMessage
      try {
        message = checkMessage(TypedValue.fromWire(record.value).toObject())
      } catch (error) {
        // Only a value that isn't a Message is skipped; checkMessage refuses one with a RangeError.
        if (!(error instanceof RangeError)) throw error
        return
      }
      // A person's action, such as a /model choice, is something they did: it never shows as a message.
      if (actionOnly(message)) return
      // Its last text part is all that shows: earlier ones are the turn's context.
      const text = message.parts.findLast((part) => part.type === "text") as { text: string } | undefined
      const shown = { author: message.author, parts: text === undefined ? [] : [{ type: "text", text: text.text }] }
      // Only a person's: a note names no one, and a send by anything else is no one's to move.
      const by = record.by?.kind === "user" ? record.by.name : null
      const send: Send = {
        seq,
        at,
        message: shown as Send["message"],
        key: record.sendKey,
        ...(queued ? { queued } : {}),
        ...(by === null ? {} : { by }),
      }
      state.sends.set(seq, keep(state, send))
      if (record.sendKey !== null) state.keys.add(keep(state, record.sendKey))
    } else if (record.take !== null && MAIN_CHAT.isTurn(record.nodeId)
      && takeInboxes(record.take.inbox).includes(inbox)) {
      // A take of several inboxes lists all their sends; only the chat inbox's and the queue's are in `sends`, to show.
      state.takes.set(seq, keep(state, record.take.events.map(Number)))
      if (before(record.take.events)) state.undecided = true
    }
  } else if (kind === "node_succeeded") {
    const commit = (record as { commit: number }).commit
    if (MAIN_CHAT.isTurn(nodeId) && commit < first) state.undecided = true
    const take = state.takes.get(commit)
    if (take !== undefined) {
      state.takes.delete(commit)
      state.items.push({ kind: "take", events: take })
      for (const event of take) state.read.add(event)
    }
    if (reply !== null) state.settled.add(keep(state, reply))
  } else if (kind === "node_failed") {
    // A failure that names the reply inside its flow call's scope (the scope couldn't grow) fails only that call.
    if (reply !== null && (record as { scope: string | null }).scope === null) state.settled.add(keep(state, reply))
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
      if (kept.kind === "steer") {
        for (const event of kept.from as readonly number[]) state.read.add(event)
        if (before(kept.from as readonly number[])) state.undecided = true
      }
    }
  } else if (kind === "run_cancelled" || kind === "run_failed") {
    state.ended = true
  } else if (kind === "inbox_withdrawn") {
    // Taken back before anything read them: they show no more, and one sent again shows under its new seq.
    const { inbox: from, events } = record as { inbox: string; events: readonly number[] }
    if (from !== inbox && from !== queue) return
    if (before(events)) state.undecided = true
    for (const event of events) {
      const by = state.sends.get(Number(event))?.by ?? null
      state.sends.delete(Number(event))
      state.withdrawn.set(Number(event), { queued: from === queue, by })
      state.held += OVERHEAD
    }
  }
}

/** Appends to `out` the messages of the run `runId` from its read `read` (`render`), then, for the session's last
 *  run (`last`), its sends no take or steer has read, unread. */
function renderRun(
  out: Message[],
  sessionId: string,
  runId: string,
  read: readonly Fold[],
  live: readonly LiveViewCall[] | null,
  last: boolean,
): void {
  render(out, sessionId, runId, read, live, last)
  // A replaced run's unread sends were moved into the fresh run, so only the last run's wait unread.
  if (!last) return
  for (const segment of read) {
    for (const send of segment.sends.values()) {
      if (!readIn(read, send.seq)) out.push(userMessage(sessionId, runId, send, true))
    }
  }
}

/**
 * Appends to `out` the messages of the run `runId` from its read `read`, whose segments' items it walks in log order:
 * each accepted take's user messages, each reply's assistant message, and the user messages a steer read, between
 * what the reply said before and after. `live` is the model calls in flight of a run a worker runs, null when none
 * runs it; `last` says the run is the session's last.
 */
function render(
  out: Message[],
  sessionId: string,
  runId: string,
  read: readonly Fold[],
  live: readonly LiveViewCall[] | null,
  last: boolean,
): void {
  const ended = read.some((segment) => segment.ended)
  const settled = (node: string) => read.some((segment) => segment.settled.has(node))
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
  for (const item of read.flatMap((segment) => segment.items)) {
    if (item.kind === "take") {
      for (const seq of item.events) {
        const send = sendIn(read, seq)
        if (send) out.push(userMessage(sessionId, runId, send, false))
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
              yian_call_id: null,
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
        if (part === undefined) continue
        waiting.add(part)
        // Yian's id for the call, which a card holding it names.
        if (typeof step.call_id === "string") part.yian_call_id = step.call_id
      } else if (step.kind === "steer") {
        // What the model says after reading a steer follows it, in a message of its own.
        for (const event of step.from as readonly number[]) {
          const send = sendIn(read, event)
          if (send) out.push(userMessage(sessionId, runId, send, false))
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
    const running = last && !ended && !settled(node) && (waiting.has(part) || live !== null)
    part.state = running ? "running" : "interrupted"
  }
}

/** The assistant message the record at `seq` (at `at`) of the run `runId` opens, with no parts yet. */
function assistantMessage(sessionId: string, runId: string, seq: number, at: string): Message {
  const id = messageId(runId, seq)
  return {
    id,
    session_id: sessionId,
    role: "assistant",
    author: null,
    instrument: null,
    unread: false,
    queued: false,
    parts: [],
    created_at: at,
  }
}

/** The user message of `send` in the run `runId`: its last text part, since earlier ones are the turn's context. A
 *  send under an instrument's note key (`NOTE_KEY`) is that instrument's note, signed by it; any other names its human
 *  author. `unread` says it still waits in the run's inbox, or in its queue for a send that went there (`queued`). */
export function userMessage(sessionId: string, runId: string, send: Send, unread: boolean): Message {
  const id = messageId(runId, send.seq)
  const text = send.message.parts.findLast((part) => part.type === "text") as { text: string } | undefined
  const shell = send.key ? NOTE_KEY.exec(send.key)?.[1] : undefined
  const name = send.message.author
  const instrument = shell !== undefined && typeof name === "string" && name !== "" ? { id: shell, name } : null
  const author = instrument === null ? Handle.safeParse(name) : null
  return {
    id,
    session_id: sessionId,
    role: "user",
    author: author?.success ? author.data : null,
    instrument,
    unread,
    queued: unread && send.queued === true,
    parts: text === undefined ? [] : [{ id: `${id}:0`, type: "text", text: text.text }],
    created_at: send.at,
  }
}

/** Whether a send the run just took, at `seq` of the run `runId`, shows unread: as `transcript` says from its cached
 *  fold, and unread with none cached, since nothing has read the run since (the live relay publishes it read once a
 *  render shows the run read it). A read that fails shows it read, and `log` hears why. */
export function sentUnread(
  transcript: Pick<Transcript, "unread">,
  runId: string,
  seq: number,
  log: (line: string) => void,
): boolean {
  try {
    return transcript.unread(runId, seq) ?? true
  } catch (error) {
    log(`whether a message was read can't be told (${errorName(error)}); it shows read`)
    return false
  }
}

/** A send a withdraw took back from a run's inbox, as its log records it: its seq, its message, the key it was sent
 *  under, if any, who sent it (`by`), if its record says, and the person whose withdraw took it (`takenBy`), if that
 *  withdraw named one. */
export interface WithdrawnSend {
  readonly seq: number
  readonly message: RunMessage
  readonly key: string | null
  readonly by: PoolCommitRecord["by"]
  readonly takenBy: string | null
}

/**
 * The sends of the inbox `inbox` that Esc's withdraws took back in the run log `log`, in send order: each
 * `inbox_withdrawn` record of every unread send names their seqs, and the send records before it hold their messages
 * and keys. A withdraw that named its sends (a person's delete, or a move to the queue or back) isn't Esc's: those
 * sends are gone, or sent to the other inbox; with `named`, only those are listed. The log is the record of what a
 * withdraw took, even when its worker died before it answered. A send whose value isn't a message is left out.
 */
export function withdrawnSends(log: string, inbox: string, { named = false }: { named?: boolean } = {}): WithdrawnSend[] {
  const sends = new Map<number, Omit<WithdrawnSend, "seq" | "takenBy">>()
  const taken = new Map<number, string | null>()
  for (const entry of iterRunRecords(log)) {
    const record = entry.envelope.record
    if (entry.kind === "pool_commit" && record instanceof PoolCommitRecord && record.value !== null) {
      if (record.key !== `${record.nodeId}.${inbox}`) continue
      try {
        const message = checkMessage(TypedValue.fromWire(record.value).toObject())
        sends.set(entry.seq, { message, key: record.sendKey, by: record.by })
      } catch (error) {
        if (!(error instanceof RangeError)) throw error
      }
    } else if (entry.kind === "inbox_withdrawn") {
      const { inbox: from, events, chosen, by } = record as {
        inbox: string
        events: readonly number[]
        chosen: boolean
        by: { kind?: string; name?: string } | null
      }
      const person = by?.kind === "user" && typeof by.name === "string" ? by.name : null
      if (from === inbox && chosen === named) for (const event of events) taken.set(Number(event), person)
    }
  }
  return [...taken]
    .sort(([a], [b]) => a - b)
    .flatMap(([seq, takenBy]) => {
      const send = sends.get(seq)
      return send === undefined ? [] : [{ seq, ...send, takenBy }]
    })
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

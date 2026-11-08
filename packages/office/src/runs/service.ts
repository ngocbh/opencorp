/** The Run Logs reads: the list of runs, from the office's rows, the session actor's memory and yian's run index
 *  (no run log is read for it); and, per run, its page, from its log. */
import fs from "node:fs"
import path from "node:path"
import type { Readable } from "node:stream"
import type {
  Event,
  RunDetail,
  RunEvent,
  RunEventPage,
  RunNode,
  RunNodePage,
  RunPage,
  RunSummary,
} from "@opencorp/protocol"
import type { RunIndexRow, RunStatus } from "@ngocbh/yian/run"
import { NotFound, cutReason, type RunRow, type SessionRecord, type Store } from "../store/store.ts"
import { errorName } from "../worker/rpc.ts"
import { kindOf } from "./nodes.ts"
import { runUpdated } from "./notify.ts"
import { COULDNT_RESUME, COULDNT_START, WORKER_STOPPED } from "./outcomes.ts"
import {
  ERROR_CHARS,
  type FoldOptions,
  type Index,
  logStream,
  nodePage,
  NotALog,
  readEvents,
  RunLogReader,
  UnreadableLog,
} from "./reader.ts"
import { Inspections, Live, readIndex, Summaries, YianRuns } from "./records.ts"

export const PAGE = 50
/** How many rows a filtered list reads at a time. */
export const BATCH = 100
/** The most runs one list request looks at to fill a filtered page; `next` resumes after them. */
export const SCAN_CAP = 1_000
/** The statuses of a run with no end yet (an interrupted one may have either). */
export const OPEN_STATUSES: ReadonlySet<string> = new Set(["running", "waiting", "idle"])

export const NOT_STARTED = "no run log: the run didn't start"
export const NOT_STARTED_YET = "not started yet"
export const LOG_GONE = "the run log is gone"

const ENDED: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "cancelled"])
/** The office ends of a run that never wrote its log. */
const NEVER_STARTED: ReadonlySet<string> = new Set([COULDNT_START, COULDNT_RESUME, WORKER_STOPPED])

/** The run has no log to read: it didn't start, or the file is gone. */
export class NoLog extends Error {
  override name = "NoLog"
}

/** Whether `error` says the log doesn't exist (its `fs` error), or isn't a regular file (NotALog). */
function isMissing(error: unknown): boolean {
  return error instanceof NotALog || (error as { code?: unknown } | null)?.code === "ENOENT"
}

/** A list request's filters and paging. */
export interface RunFilters {
  flow?: string | null
  person?: string | null
  status?: Iterable<string>
  q?: string | null
  since?: string | null
  until?: string | null
  recent?: string | null
  before?: string | null
  limit?: number
}

/** The list's filters: a run matches all that are set (any one of `statuses`); `since` (inclusive) and `until`
 *  (exclusive) bound its launch time; with `recent`, a run matches when it's open (running, waiting or idle) or
 *  launched at or after it. A top-level run shows when it or a run it started matches.
 *
 *  The store applies the launch range to the rows it pages: top-level rows launched in it or with a child launched
 *  in it, exactly the ones the range alone shows. So only the other filters need summaries. For `recent` it pages
 *  the rows with no end or launched since, and a summary says which of those with no end are open. */
export class RunFilter {
  readonly flow: string | null
  readonly person: string | null
  readonly statuses: ReadonlySet<string>
  /** Any part of a run id, trimmed. */
  readonly q: string | null
  readonly since: string | null
  readonly until: string | null
  readonly recent: string | null

  constructor(filters: RunFilters = {}) {
    this.flow = filters.flow || null
    this.person = filters.person || null
    this.statuses = new Set(filters.status ?? [])
    this.q = filters.q?.trim() || null
    this.since = filters.since || null
    this.until = filters.until || null
    this.recent = filters.recent || null
  }

  /** Whether matching a run needs more than its row's launch time. */
  get summariesNeeded(): boolean {
    return !!(this.flow || this.person || this.statuses.size > 0 || this.q || this.recent)
  }

  /** Whether only runs with no end yet can match: every wanted status is one of an open run. */
  get openOnly(): boolean {
    return this.statuses.size > 0 && [...this.statuses].every((s) => OPEN_STATUSES.has(s))
  }

  /** Whether `run` matches every filter set. */
  matches(run: RunSummary): boolean {
    return (
      (!this.flow || run.flow === this.flow) &&
      (!this.person || run.driver === this.person || (run.participants ?? []).includes(this.person)) &&
      (this.statuses.size === 0 || this.statuses.has(run.status)) &&
      (!this.q || run.run_id.includes(this.q.toUpperCase())) &&
      (!this.since || run.launched_at >= this.since) &&
      (!this.until || run.launched_at < this.until) &&
      (!this.recent || OPEN_STATUSES.has(run.status) || run.launched_at >= this.recent)
    )
  }
}

/** What one request reads once: yian's facts, its parent links (child run id to parent's) and the runs it ended. */
interface ListRead {
  yian: YianRuns
  links: Map<string, string>
  ended: string[]
  summaries: Summaries
}

/** The Run Logs list and run pages. Logs and reasons are shown as stored, reasons and node errors cut only for
 *  length. */
export class RunLogs {
  readonly #store: Store
  readonly #runsDir: string
  // Kept for the office's life, so a log is read whole once while its index stays cached.
  readonly #reader: RunLogReader
  readonly #pin: ((commit: string) => Promise<string>) | undefined
  readonly #live: () => Live
  readonly #index: () => ReadonlyMap<string, RunIndexRow>
  // Kept for the office's life, so ended runs' inspections stay cached.
  readonly #inspections: Inspections
  readonly #batch: number
  readonly #scanCap: number
  readonly #log: (line: string) => void

  constructor(options: {
    store: Store
    runsDir: string
    live?: () => Live
    /** yian's run index by run id: the office's `RunIndexer` rows, which its thread reads after each update. The
     *  default reads the index file on every call, for tests. */
    index?: () => ReadonlyMap<string, RunIndexRow>
    inspections?: Inspections
    batch?: number
    scanCap?: number
    log?: (line: string) => void
    reader?: RunLogReader
    /** The session's pinned company worktree for a commit: the code root a log's recorded flow compiles under. */
    pin?: (commit: string) => Promise<string>
  }) {
    this.#store = options.store
    this.#runsDir = options.runsDir
    this.#reader = options.reader ?? new RunLogReader()
    this.#pin = options.pin
    this.#log = options.log ?? (() => {})
    this.#live = options.live ?? (() => new Live())
    this.#index = options.index ?? (() => readIndex(this.#runsDir, this.#log))
    this.#inspections = options.inspections ?? new Inspections(options.runsDir)
    this.#batch = options.batch ?? BATCH
    this.#scanCap = options.scanCap ?? SCAN_CAP
  }

  /** Top-level runs after run `before` (newest first) that the filters show, at most `limit`: a run shows when it
   *  or a run it started matches. Each carries how many runs it started, not the runs. */
  page(filters: RunFilters = {}): RunPage {
    return this.#page(new RunFilter(filters), null, filters.before ?? null, filters.limit ?? PAGE)
  }

  /** The runs started from run `parent` that match the filters, paged as `page` is; NotFound if `parent` has no
   *  row. */
  children(parent: string, filters: RunFilters = {}): RunPage {
    return this.#page(new RunFilter(filters), parent, filters.before ?? null, filters.limit ?? PAGE)
  }

  /** Where a run's log is: derived from the runs folder, never stored. */
  logPath(runId: string): string {
    return path.join(this.#runsDir, runId, "log.jsonl")
  }

  /** A run page's header: the run with its parent and children, usage, what its log's first record says, and
   *  whether the log can be read; NotFound if there is no such run. */
  async detail(runId: string): Promise<RunDetail> {
    const { row, session } = this.#one(runId)
    const { yian, summaries } = this.#read()
    const run = summaries.build([row], { children: summaries.children([runId]) }).get(runId)!
    const indexRow = yian.row(runId)
    const parentId = indexRow?.parentRunId ?? null
    const parentRow = parentId === null ? undefined : this.#store.getRun(parentId)
    const parent = parentRow ? (summaries.build([parentRow]).get(parentRow.runId) ?? null) : null
    return {
      run,
      parent,
      repo_commit: session.repo_commit,
      usage: {
        input_tokens: indexRow?.inputTokens ?? 0,
        output_tokens: indexRow?.outputTokens ?? 0,
        usd: this.#store.runUsageUsd(runId),
      },
      ...(await this.#logState(row, indexRow)),
    }
  }

  /** The header's log fields: whether the run's log can be read, and what its first record says. */
  async #logState(
    row: RunRow,
    indexRow: RunIndexRow | undefined,
  ): Promise<Pick<RunDetail, "log_state" | "log_message" | "flow_fingerprint" | "models">> {
    const file = this.logPath(row.runId)
    const gone = { log_state: "missing", log_message: LOG_GONE } as const
    if (!fs.existsSync(file)) {
      if (row.endReason === null && indexRow === undefined) {
        return { log_state: "not_started", log_message: NOT_STARTED_YET }
      }
      if (row.endReason !== null && NEVER_STARTED.has(row.endReason)) {
        return { log_state: "not_started", log_message: NOT_STARTED }
      }
      return gone
    }
    let index: Index
    try {
      index = await this.#reader.index(file)
    } catch (error) {
      // An unknown or retired schema, a line that isn't a record, seqs out of order.
      if (error instanceof UnreadableLog) return { log_state: "unsupported_schema", log_message: error.message }
      if (isMissing(error)) return gone
      throw error
    }
    return { log_state: "ok", flow_fingerprint: index.fingerprint, models: index.models }
  }

  /** Node attempts that started before seq `before`, newest first, with their kinds, errors cut to ERROR_CHARS;
   *  NotFound without the run, NoLog without its log, UnreadableLog for a log this office can't read. */
  async nodes(runId: string, { before, limit }: { before: number | null; limit: number }): Promise<RunNodePage> {
    const { file, index, session } = await this.#logIndex(runId)
    const fold = await this.#fold(session)
    const kinds = fold ? await this.#reader.kinds(file, index, fold) : null
    const page = nodePage(index, { before, limit })
    return {
      nodes: page.nodes.map((a): RunNode => ({
        seq: a.seq,
        end_seq: a.endSeq,
        node_id: a.nodeId,
        kind: kindOf(kinds, a.nodeId),
        // The protocol has no waiting node: a waiting node is in progress.
        status: a.status === "waiting" ? "open" : a.status,
        handle: a.handle,
        error: a.error === null ? null : cutReason(a.error, ERROR_CHARS),
      })),
      dividers: page.dividers.map(([seq, retried]) => ({ seq, retried })),
      next_before: page.nextBefore,
      dropped: page.dropped,
    }
  }

  /** Records after seq `after`, as stored but cut for size; NotFound, NoLog or UnreadableLog as `nodes`. */
  async events(runId: string, { after, limit }: { after: number | null; limit: number }): Promise<RunEventPage> {
    const { file, index } = await this.#logIndex(runId)
    return readEvents(file, index, { after, limit })
  }

  /** The record with `seq`, a derived commit with the value it accepted; NotFound if there is none. */
  async event(runId: string, seq: number): Promise<RunEvent> {
    const { file, index, session } = await this.#logIndex(runId)
    const found = await this.#reader.readEvent(file, index, seq, { fold: await this.#fold(session) })
    if (found === null) throw new NotFound(`run ${runId} has no record ${seq}`)
    return found
  }

  /** The index of the log `file`, brought up to date, for a live stream to start near a seq and to check the records
   *  it sends against; null when the log can't be indexed (another schema, a line it refuses, not a regular file,
   *  gone, any other error), and the stream then sends `reset`. Never rejects, so the stream can start it before it
   *  needs it. */
  async logIndex(file: string): Promise<Index | null> {
    try {
      return await this.#reader.index(file)
    } catch {
      return null
    }
  }

  /** The whole log as it is now, as stored. It needs no index, so a log this office can't read still downloads.
   *  The log is opened before this resolves, so one removed meanwhile is NoLog, not a cut-off download. */
  async log(runId: string): Promise<Readable> {
    this.#one(runId)
    try {
      return await logStream(this.logPath(runId))
    } catch (error) {
      if (isMissing(error)) throw new NoLog(`run ${runId} has no log`)
      throw error
    }
  }

  /** The run's run.updated, from its summary (one live read, one index read); null without its row or session. */
  runUpdated(runId: string): Event | null {
    const row = this.#store.getRun(runId)
    if (row === undefined) return null
    const run = this.#read().summaries.build([row]).get(runId)
    if (!run) return null
    return runUpdated(runId, run.session_id, run.parent_run_id ?? null, run.status, run.current_nodes ?? [])
  }

  /** The run's row and its session; NotFound without either. */
  #one(runId: string): { row: RunRow; session: SessionRecord } {
    const row = this.#store.getRun(runId)
    const session = row && this.#store.getSession(row.sessionId)
    if (!row || !session) throw new NotFound(`no run ${runId}`)
    return { row, session }
  }

  /** One read of memory and of yian's index, for summaries. */
  #read(): { yian: YianRuns; summaries: Summaries } {
    const live = this.#live()
    const yian = new YianRuns(this.#index(), this.#inspections)
    return { yian, summaries: new Summaries(this.#store, live, yian, { fresh: this.#live, log: this.#log }) }
  }

  /** The run's log, its index brought up to date, and its session; NoLog when the log doesn't exist or isn't a
   *  regular file. */
  async #logIndex(runId: string): Promise<{ file: string; index: Index; session: SessionRecord }> {
    const { session } = this.#one(runId)
    const file = this.logPath(runId)
    try {
      return { file, index: await this.#reader.index(file), session }
    } catch (error) {
      if (isMissing(error)) throw new NoLog(`run ${runId} has no log`)
      throw error
    }
  }

  /** How a log of `session`'s is replayed: under its pinned company worktree; undefined without one. */
  async #fold(session: SessionRecord): Promise<FoldOptions | undefined> {
    if (!this.#pin) return undefined
    try {
      return { env: () => undefined, codeRoot: await this.#pin(session.repo_commit) }
    } catch (error) {
      this.#log(`pin for a run page failed (${errorName(error)})`)
      return undefined
    }
  }

  /** A page of top-level runs, or of `parent`'s children.
   *
   *  The store pages rows in the launch range. Other filters are applied to summaries built a batch of rows at a
   *  time, so a filtered page may stop after the scan cap with fewer runs; `next` resumes.
   *
   *  Memory is read first, then yian's index and the store, then memory again per batch (`Summaries`): a run that
   *  ends or starts while the page is built never reads as interrupted. */
  #page(wanted: RunFilter, parent: string | null, before: string | null, limit: number): RunPage {
    const live = this.#live()
    const index = this.#index()
    const yian = new YianRuns(index, this.#inspections)
    const links = new Map<string, string>()
    const ended: string[] = []
    for (const row of index.values()) {
      if (row.parentRunId !== null) links.set(row.runId, row.parentRunId)
      if (ENDED.has(row.status)) ended.push(row.runId)
    }
    if (parent !== null && this.#store.getRun(parent) === undefined) throw new NotFound(`no run ${parent}`)
    const summaries = new Summaries(this.#store, live, yian, { fresh: this.#live, log: this.#log })
    return this.#rows(wanted, parent, before, limit, { yian, links, ended, summaries })
  }

  #rows(wanted: RunFilter, parent: string | null, before: string | null, limit: number, request: ListRead): RunPage {
    const read = (cursor: string | null, ask: number) =>
      this.#store.runPage({
        before: cursor,
        limit: ask,
        parent,
        links: request.links,
        since: wanted.since,
        until: wanted.until,
        recent: wanted.recent,
        ended: request.ended,
      })
    const out: RunSummary[] = []
    let cursor = before
    let scanned = 0
    let exhausted = false
    while (out.length < limit && scanned < this.#scanCap) {
      const ask = wanted.summariesNeeded ? Math.min(this.#batch, this.#scanCap - scanned) : limit - out.length
      const rows = read(cursor, ask)
      const built = request.summaries.build(rows)
      const kids = parent === null ? this.#matchingChildren(rows, wanted, request) : new Set<string>()
      for (const row of rows) {
        scanned += 1
        cursor = row.runId
        const run = built.get(row.runId)
        // Without filters past the range, every row the store gave shows (a top-level one launched before the
        // range is there for a child launched in it).
        if (run && (!wanted.summariesNeeded || wanted.matches(run) || kids.has(row.runId))) {
          out.push(run)
          if (out.length === limit) break
        }
      }
      if (rows.length < ask) {
        // The store has nothing after these rows.
        exhausted = rows.length === 0 || cursor === rows.at(-1)!.runId
        break
      }
    }
    const more = !exhausted && cursor !== null && read(cursor, 1).length > 0
    return { runs: out, next: more ? cursor : null }
  }

  /** The ids of those of `rows` with a child that matches `wanted` (none to check without filters). The store
   *  leaves out the children the launch range, `recent` or an open-only status filter can't match. */
  #matchingChildren(rows: RunRow[], wanted: RunFilter, request: ListRead): Set<string> {
    if (rows.length === 0 || !wanted.summariesNeeded) return new Set()
    const childIds = [...request.yian.children(rows.map((r) => r.runId)).values()].flat()
    const kids = this.#store.runsAmong(childIds, {
      since: wanted.since,
      until: wanted.until,
      recent: wanted.recent,
      ended: request.ended,
      openOnly: wanted.openOnly,
    })
    const built = request.summaries.build(kids)
    const out = new Set<string>()
    for (const kid of kids) {
      const run = built.get(kid.runId)
      if (run && wanted.matches(run)) out.add(request.links.get(kid.runId)!)
    }
    return out
  }
}

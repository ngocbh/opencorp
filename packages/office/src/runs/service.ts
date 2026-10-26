/** The Run Logs reads: the list of runs, from the office's rows, the session actor's memory and yian's run index
 *  (no run log is read for it). */
import type { RunPage, RunSummary } from "@opencorp/protocol"
import type { RunIndexRow, RunStatus } from "@ngocbh/yian/run"
import { NotFound, type RunRow, type Store } from "../store/store.ts"
import { Inspections, Live, readIndex, Summaries, YianRuns } from "./records.ts"

export const PAGE = 50
/** How many rows a filtered list reads at a time. */
export const BATCH = 100
/** The most runs one list request looks at to fill a filtered page; `next` resumes after them. */
export const SCAN_CAP = 1_000
/** The statuses of a run with no end yet (an interrupted one may have either). */
export const OPEN_STATUSES: ReadonlySet<string> = new Set(["running", "waiting", "idle"])

const ENDED: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "cancelled"])

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

/** The Run Logs list. Logs and reasons are shown as stored, reasons cut only for length. */
export class RunLogs {
  readonly #store: Store
  readonly #live: () => Live
  readonly #index: () => Map<string, RunIndexRow>
  // Kept for the office's life, so ended runs' inspections stay cached.
  readonly #inspections: Inspections
  readonly #batch: number
  readonly #scanCap: number
  readonly #log: (line: string) => void

  constructor(options: {
    store: Store
    runsDir: string
    live?: () => Live
    index?: () => Map<string, RunIndexRow>
    inspections?: Inspections
    batch?: number
    scanCap?: number
    log?: (line: string) => void
  }) {
    this.#store = options.store
    this.#log = options.log ?? (() => {})
    this.#live = options.live ?? (() => new Live())
    this.#index = options.index ?? (() => readIndex(options.runsDir, this.#log))
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

/** A run's status, current nodes and participants for Run Logs and run pages: from the office's rows, the session
 *  actor's memory, and yian's run index and logs. */
import fs from "node:fs"
import path from "node:path"
import { RunSummary } from "@opencorp/protocol"
import { withWarnings } from "@ngocbh/yian/platform"
import {
  inspectRun,
  readRunIndex,
  type RunIndexRow,
  type RunInspection,
  type RunStatus,
  type WaitInfo,
} from "@ngocbh/yian/run"
import { LIVE } from "../chat/state.ts"
import { MAIN_CHAT } from "../chat/turns.ts"
import {
  REASON_CHARS,
  cutReason,
  type QuestionRecord,
  type RunRow,
  type SessionRecord,
  type Store,
} from "../store/store.ts"
import { errorName } from "../worker/rpc.ts"
import { COULDNT_RESUME, COULDNT_START, DEBRIEF, FLOWS, OFFICE_STOPPED, WORKER_STOPPED } from "./outcomes.ts"

export const NO_OUTCOME = "ended without a recorded outcome"
/** The most children a run's page shows with it (the newest). */
export const CHILDREN_SHOWN = 200
/** The reason of a run yian's host stopped. */
export const STOPPED = "stopped"
/** The reason of a run yian cancelled without an end the office wrote. */
export const CANCELLED = "cancelled"
/** The size at which the warned-about runs and the cached inspections are cleared, so they stay small. */
export const WARNED_CAP = 10_000

/** How long reading the index waits while an update commits, in milliseconds. */
const READ_TIMEOUT_MS = 500
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
const FAILED_ENDS = new Set([COULDNT_START, COULDNT_RESUME, WORKER_STOPPED])
const ENDED: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "cancelled"])
const warned = new Set<string>() // runs already warned about

/** A run's status as the protocol shows it. */
export type RunStatusShown = "running" | "waiting" | "idle" | "finished" | "failed" | "interrupted"

/** What the session actor knows of one live run: its state (starting and ending count as running) and its open
 *  nodes while running, its waiting nodes while waiting or idle. */
export interface LiveRun {
  readonly status: "running" | "waiting" | "idle"
  readonly nodes: readonly string[]
}

/** What memory says about runs (one read, or several merged), by run id. */
export class Live {
  readonly runs: ReadonlyMap<string, LiveRun>

  constructor(runs: ReadonlyMap<string, LiveRun> = new Map()) {
    this.runs = runs
  }

  /** Both reads at once: `later`'s entry for a run wins, the others are kept. */
  merged(later: Live): Live {
    return new Live(new Map([...this.runs, ...later.runs]))
  }

  /** The live run's nodes; none for a run not in memory. */
  nodes(runId: string): readonly string[] {
    return this.runs.get(runId)?.nodes ?? []
  }
}

/** What yian says about one run, from its index row or its log. */
export interface YianRun {
  status: RunStatus | null
  failure: { message: string; nodeId: string | null } | null
  waits: readonly WaitInfo[]
  parentRunId: string | null
  endedAt: string | null
}

/** `inspectRun` answers by run id; an ended run's answer is read once, since an ended log doesn't change. */
export class Inspections {
  readonly runsDir: string
  readonly #inspect: (log: string) => RunInspection
  readonly #ended = new Map<string, YianRun>()

  constructor(runsDir: string, inspect: (log: string) => RunInspection = inspectRun) {
    this.runsDir = runsDir
    this.#inspect = inspect
  }

  /** The run's log as `inspectRun` reads it; `null` when the log can't be read. */
  get(runId: string): YianRun | null {
    const cached = this.#ended.get(runId)
    if (cached) return cached
    let seen: RunInspection
    try {
      seen = this.#inspect(path.join(this.runsDir, runId, "log.jsonl"))
    } catch {
      // A missing, damaged or newer-schema log is no answer.
      return null
    }
    const run: YianRun = {
      status: seen.status,
      failure: seen.failure && { message: seen.failure.message, nodeId: seen.failure.nodeId },
      waits: seen.waits,
      parentRunId: null,
      endedAt: seen.endedAt,
    }
    if (ENDED.has(seen.status)) {
      if (this.#ended.size >= WARNED_CAP) this.#ended.clear()
      this.#ended.set(runId, run)
    }
    return run
  }
}

function rowFacts(row: RunIndexRow): YianRun {
  return { status: row.status, failure: null, waits: row.waits, parentRunId: row.parentRunId, endedAt: row.endedAt }
}

/** yian's facts about runs: one read of its run index, and its logs for what the index can't say. */
export class YianRuns {
  readonly #index: ReadonlyMap<string, RunIndexRow>
  readonly #inspections: Inspections
  #children: Map<string, string[]> | undefined

  constructor(index: ReadonlyMap<string, RunIndexRow>, inspections: Inspections) {
    this.#index = index
    this.#inspections = inspections
  }

  /** The run's index row, if the index has one. */
  row(runId: string): RunIndexRow | undefined {
    return this.#index.get(runId)
  }

  /** The run ids of the index rows whose parent is one of `parentIds`, by parent id; a parent with none is left
   *  out. */
  children(parentIds: Iterable<string>): Map<string, string[]> {
    if (!this.#children) {
      // The index doesn't change for this lookup, so it is scanned once.
      this.#children = new Map()
      for (const row of this.#index.values()) {
        if (row.parentRunId === null) continue
        const kids = this.#children.get(row.parentRunId)
        if (kids) kids.push(row.runId)
        else this.#children.set(row.parentRunId, [row.runId])
      }
    }
    const out = new Map<string, string[]>()
    for (const id of parentIds) {
      const kids = this.#children.get(id)
      if (kids) out.set(id, [...kids])
    }
    return out
  }

  /** Whether yian ended the run (succeeded, failed or cancelled) or a writer holds its log now (running): its index
   *  row says so, else its log does. */
  endedOrRunning(runId: string): boolean {
    const status = this.#index.get(runId)?.status
    if (status === "running" || (status && ENDED.has(status))) return true
    // A row from before the run ended (an update that failed) must not hide its end, so the log is asked too.
    const seen = this.#inspections.get(runId)?.status
    return seen === "running" || (!!seen && ENDED.has(seen))
  }

  /** What yian says about the run: its index row, with a failed run's failure from its log; the log's answer for a
   *  run the index has no end for or whose row is stale; `null` when neither knows the run. */
  ofRun(runId: string): YianRun | null {
    const row = this.#index.get(runId)
    if (row && this.#settled(row)) {
      // Index rows carry no failure.
      if (row.status === "failed") return { ...rowFacts(row), failure: this.#inspections.get(runId)?.failure ?? null }
      return rowFacts(row)
    }
    const seen = this.#inspections.get(runId)
    if (seen) return { ...seen, parentRunId: row?.parentRunId ?? null }
    return row ? rowFacts(row) : null
  }

  /** The row's status needs no log: the run ended, or it waits or stopped and the row was built from the whole log
   *  (the size check yian's own update makes; a missing log counts as stale). */
  #settled(row: RunIndexRow): boolean {
    if (ENDED.has(row.status)) return true
    if (row.status !== "waiting" && row.status !== "stopped") return false
    try {
      return fs.statSync(path.join(this.#inspections.runsDir, row.runId, "log.jsonl")).size === row.offset
    } catch {
      return false
    }
  }
}

/** yian's run index under `runsDir` by run id; empty when it can't be read. A row yian skips is logged by its log's
 *  path, never with yian's message (which may quote the log). */
export function readIndex(runsDir: string, log: (line: string) => void = () => {}): Map<string, RunIndexRow> {
  try {
    const rows = withWarnings(
      (warning) => {
        // yian names a row it skips by run id.
        const match = /^run index skipped (.+?): /.exec(warning)
        if (match) log(`run index skipped ${path.join(runsDir, match[1]!, "log.jsonl")}`)
      },
      () => readRunIndex(runsDir, { timeoutMs: READ_TIMEOUT_MS }),
    )
    return new Map(rows.map((row) => [row.runId, row]))
  } catch (error) {
    log(`run index read failed (${errorName(error)})`)
    return new Map()
  }
}

/** Ends, as the office stopped and with no end time, each run an earlier office left open: the office rows with no
 *  end reason, but each live composer session's current run (restore resumes, replaces or fails it, or it sleeps),
 *  the runs yian ended and the runs whose log a writer holds now. Returns the run ids it wrote, in run-id order.
 *
 *  The office end goes only on runs yian didn't end and can't still end: in the run status rule an office end
 *  reason wins over yian's status, so it would hide yian's outcome. */
export function sweep(store: Store, yian: YianRuns): string[] {
  const keep = new Set(
    store
      .listSessions({ status: [...LIVE] })
      .flatMap((s) => (s.harness === "composer" && s.run_ids.length > 0 ? [s.run_ids.at(-1)!] : [])),
  )
  const rest = store.openRuns().flatMap((r) => (keep.has(r.runId) || yian.endedOrRunning(r.runId) ? [] : [r.runId]))
  return store.sweepRuns(rest, OFFICE_STOPPED)
}

/** A run's status, reason and failed node, and what yian said about it (`null` when the office's end reason or the
 *  actor's memory answered, or yian doesn't know the run); the first rule that matches wins. */
export function statusOf(
  row: RunRow,
  session: SessionRecord | undefined,
  live: Live,
  yian: YianRuns,
  log: (line: string) => void = () => {},
): { status: RunStatusShown; reason: string | null; failedNode: string | null; yian: YianRun | null } {
  if (row.endReason !== null) {
    const status = FAILED_ENDS.has(row.endReason) ? "failed" : "interrupted"
    return { status, reason: row.endReason, failedNode: null, yian: null }
  }
  const current = live.runs.get(row.runId)
  if (current && session?.run_ids.at(-1) === row.runId) {
    return { status: current.status, reason: null, failedNode: null, yian: null }
  }
  const run = yian.ofRun(row.runId)
  switch (run?.status) {
    case "succeeded":
      return { status: "finished", reason: null, failedNode: null, yian: run }
    case "failed":
      return {
        status: "failed",
        reason: run.failure ? cutReason(run.failure.message, REASON_CHARS) : null,
        failedNode: run.failure?.nodeId ?? null,
        yian: run,
      }
    case "stopped":
      return { status: "interrupted", reason: STOPPED, failedNode: null, yian: run }
    case "waiting": {
      const idle = run.waits.length > 0 && run.waits.every((w) => MAIN_CHAT.isTurn(w.node))
      return { status: idle ? "idle" : "waiting", reason: null, failedNode: null, yian: run }
    }
    case "cancelled":
      return { status: "interrupted", reason: CANCELLED, failedNode: null, yian: run }
  }
  if (!warned.has(row.runId)) {
    // A missing end path: say so once per run.
    if (warned.size >= WARNED_CAP) warned.clear()
    warned.add(row.runId)
    log(`run ${row.runId} has no recorded outcome and nothing runs it`)
  }
  return { status: "interrupted", reason: NO_OUTCOME, failedNode: null, yian: run }
}

/** The node ids a run in `status` is at, whether a model question is open (`asking`), and whether it waits with
 *  nothing open (`held`, at its cost cap). The run's nodes are the actor's when it is in memory, else its waits'. */
export function currentNodes(
  status: RunStatusShown,
  runId: string,
  openQuestions: QuestionRecord[],
  live: Live,
  waits: readonly WaitInfo[],
): { nodes: string[]; asking: boolean; held: boolean } {
  const source = live.runs.has(runId) ? [...live.nodes(runId)] : [...new Set(waits.map((w) => w.node))]
  if (status === "idle") return { nodes: source.filter((n) => MAIN_CHAT.isTurn(n)), asking: false, held: false }
  if (status === "waiting") {
    const nodes: string[] = []
    const asked = openQuestions.flatMap((q) => (q.node_id && !MAIN_CHAT.isTurn(q.node_id) ? [q.node_id] : []))
    for (const n of [...asked, ...source.filter((n) => !MAIN_CHAT.isTurn(n))]) if (!nodes.includes(n)) nodes.push(n)
    const asking = openQuestions.some((q) => q.node_id === null)
    return { nodes, asking, held: nodes.length === 0 && !asking }
  }
  if (status === "running") return { nodes: source, asking: false, held: false }
  return { nodes: [], asking: false, held: false }
}

/** The employee, then everyone else in order, never the driver, each once, handles only. */
export function participants(driver: string, person: string, others: Iterable<string | null | undefined>): string[] {
  const out: string[] = []
  for (const who of [person, ...others]) {
    if (who && who !== driver && !out.includes(who) && HANDLE.test(who)) out.push(who)
  }
  return out
}

/** Newest first: by launch, then run id. */
function newestFirst(a: RunRow, b: RunRow): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
  return a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0
}

/** RunSummary objects for a batch of office rows, with one store read per kind of fact (and one per session).
 *
 *  `live` is read before the store; `fresh` (when given) reads memory again after the store reads of each build,
 *  and the two are merged: a run that ends between the reads is live in the first, one that starts between them is
 *  live in the second. Children and their parents come from yian's index. A stored reason is shown cut to
 *  REASON_CHARS. */
export class Summaries {
  readonly #store: Store
  readonly #live: Live
  readonly #yian: YianRuns
  readonly #fresh: (() => Live) | undefined
  readonly #childrenShown: number
  readonly #log: (line: string) => void

  constructor(
    store: Store,
    live: Live,
    yian: YianRuns,
    options: { fresh?: () => Live; childrenShown?: number; log?: (line: string) => void } = {},
  ) {
    this.#store = store
    this.#live = live
    this.#yian = yian
    this.#fresh = options.fresh
    this.#childrenShown = options.childrenShown ?? CHILDREN_SHOWN
    this.#log = options.log ?? (() => {})
  }

  /** Each row's summary by run id, with how many runs it started (`children_total`) and no children. Given
   *  `children` (by parent id, newest first), the newest `childrenShown` of each are summarized and attached. A row
   *  whose session is gone is left out. */
  build(rows: RunRow[], options: { children?: ReadonlyMap<string, RunRow[]> } = {}): Map<string, RunSummary> {
    const children = options.children ?? new Map<string, RunRow[]>()
    const byId = new Map<string, RunRow>()
    for (const r of [...rows, ...[...children.values()].flatMap((ks) => ks.slice(0, this.#childrenShown))]) {
      byId.set(r.runId, r)
    }
    const everyone = [...byId.values()]
    const ids = everyone.map((r) => r.runId)
    const sessions = new Map<string, SessionRecord | undefined>()
    for (const r of everyone) {
      if (!sessions.has(r.sessionId)) sessions.set(r.sessionId, this.#store.getSession(r.sessionId))
    }
    const questions = new Map<string, QuestionRecord[]>()
    if (everyone.length > 0) {
      for (const q of this.#store.listQuestions({ runId: ids })) {
        const list = questions.get(q.run_id)
        if (list) list.push(q)
        else questions.set(q.run_id, [q])
      }
    }
    const kids = this.#yian.children(ids)
    const kidRows = this.#store.getRuns([...kids.values()].flat())
    const nextIds = new Map<string, string>()
    for (const r of everyone) {
      const runIds = sessions.get(r.sessionId)?.run_ids ?? []
      const i = runIds.indexOf(r.runId)
      if (i >= 0 && i + 1 < runIds.length) nextIds.set(r.runId, runIds[i + 1]!)
    }
    const nextRows = this.#store.getRuns(nextIds.values())
    const live = this.#fresh ? this.#live.merged(this.#fresh()) : this.#live
    const out = new Map<string, RunSummary>()
    for (const r of everyone) {
      const session = sessions.get(r.sessionId)
      if (!session) continue
      const openers = (kids.get(r.runId) ?? [])
        .flatMap((k) => {
          const kid = kidRows.get(k)
          return kid?.flow === FLOWS.side ? [kid] : []
        })
        .sort(newestFirst)
        .map((k) => k.driver)
      const next = nextRows.get(nextIds.get(r.runId) ?? "")
      const replacedBy = next?.replacesRunId === r.runId ? next.runId : null
      const childrenTotal = kids.get(r.runId)?.length ?? 0
      out.set(r.runId, this.#one(r, session, questions.get(r.runId) ?? [], openers, replacedBy, childrenTotal, live))
    }
    for (const [parentId, ks] of children) {
      const parent = out.get(parentId)
      if (!parent) continue
      const shown = ks.slice(0, this.#childrenShown).flatMap((k) => out.get(k.runId) ?? [])
      out.set(parentId, { ...parent, children: shown })
    }
    return out
  }

  /** The office rows of each run's index children, newest first (by launch, then run id), by parent id; a run
   *  with none is left out. */
  children(runIds: string[]): Map<string, RunRow[]> {
    const kids = this.#yian.children(runIds)
    const rows = this.#store.getRuns([...kids.values()].flat())
    const out = new Map<string, RunRow[]>()
    for (const [parentId, ids] of kids) {
      const found = ids.flatMap((id) => rows.get(id) ?? []).sort(newestFirst)
      if (found.length > 0) out.set(parentId, found)
    }
    return out
  }

  #one(
    row: RunRow,
    session: SessionRecord,
    questions: QuestionRecord[],
    openers: string[],
    replacedBy: string | null,
    childrenTotal: number,
    live: Live,
  ): RunSummary {
    const { status, reason, failedNode, yian: run } = statusOf(row, session, live, this.#yian, this.#log)
    const asleep = (status === "idle" || status === "waiting") && !live.runs.has(row.runId)
    // yian's answer gives an asleep run's waits and the end yian recorded, from the log too while the index lags.
    const waits = asleep ? (run?.waits ?? []) : []
    const open = questions.filter((q) => q.status === "open")
    const { nodes, asking, held } = currentNodes(status, row.runId, open, live, waits)
    const answerers = questions.map((q) => q.answered_by)
    let endedAt: string | null = null
    if (row.endReason !== null) endedAt = row.endedAt
    else if (run?.status && ENDED.has(run.status)) endedAt = run.endedAt
    return RunSummary.parse({
      run_id: row.runId,
      session_id: row.sessionId,
      flow: row.flow,
      flow_path: row.flowPath,
      person: session.person,
      driver: row.driver,
      participants: participants(row.driver, session.person, [...answerers, ...openers]),
      parent_run_id: this.#yian.row(row.runId)?.parentRunId ?? null,
      status,
      reason: reason === null ? null : cutReason(reason, REASON_CHARS),
      failed_node: failedNode,
      current_nodes: nodes,
      asking,
      held,
      codex: row.flow === DEBRIEF && session.harness === "codex",
      launched_at: row.createdAt,
      ended_at: endedAt,
      replaces: row.replacesRunId,
      replaced_by: replacedBy,
      children: [],
      children_total: childrenTotal,
    })
  }
}

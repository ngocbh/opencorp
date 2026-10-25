/** A run's status, current nodes and participants for Run Logs and run pages: from the office's rows, the session
 *  actor's memory, and yian's run index and logs. */
import fs from "node:fs"
import path from "node:path"
import { withWarnings } from "@ngocbh/yian/platform"
import {
  inspectRun,
  readRunIndex,
  type RunIndexRow,
  type RunInspection,
  type RunStatus,
  type WaitInfo,
} from "@ngocbh/yian/run"
import { MAIN_CHAT } from "../chat/turns.ts"
import { REASON_CHARS, cutReason, type QuestionRecord, type RunRow, type SessionRecord } from "../store/store.ts"
import { errorName } from "../worker/rpc.ts"
import { COULDNT_RESUME, COULDNT_START, WORKER_STOPPED } from "./outcomes.ts"

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

  constructor(index: ReadonlyMap<string, RunIndexRow>, inspections: Inspections) {
    this.#index = index
    this.#inspections = inspections
  }

  /** The run's index row, if the index has one. */
  row(runId: string): RunIndexRow | undefined {
    return this.#index.get(runId)
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

/** A run's status, reason and failed node; the first rule that matches wins. */
export function statusOf(
  row: RunRow,
  session: SessionRecord | undefined,
  live: Live,
  yian: YianRuns,
  log: (line: string) => void = () => {},
): { status: RunStatusShown; reason: string | null; failedNode: string | null } {
  if (row.endReason !== null) {
    const status = FAILED_ENDS.has(row.endReason) ? "failed" : "interrupted"
    return { status, reason: row.endReason, failedNode: null }
  }
  const current = live.runs.get(row.runId)
  if (current && session?.run_ids.at(-1) === row.runId) {
    return { status: current.status, reason: null, failedNode: null }
  }
  const run = yian.ofRun(row.runId)
  switch (run?.status) {
    case "succeeded":
      return { status: "finished", reason: null, failedNode: null }
    case "failed":
      return {
        status: "failed",
        reason: run.failure ? cutReason(run.failure.message, REASON_CHARS) : null,
        failedNode: run.failure?.nodeId ?? null,
      }
    case "stopped":
      return { status: "interrupted", reason: STOPPED, failedNode: null }
    case "waiting": {
      const idle = run.waits.length > 0 && run.waits.every((w) => MAIN_CHAT.isTurn(w.node))
      return { status: idle ? "idle" : "waiting", reason: null, failedNode: null }
    }
    case "cancelled":
      return { status: "interrupted", reason: CANCELLED, failedNode: null }
  }
  if (!warned.has(row.runId)) {
    // A missing end path: say so once per run.
    if (warned.size >= WARNED_CAP) warned.clear()
    warned.add(row.runId)
    log(`run ${row.runId} has no recorded outcome and nothing runs it`)
  }
  return { status: "interrupted", reason: NO_OUTCOME, failedNode: null }
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

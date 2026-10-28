/** At office start, runs an earlier office left open are interrupted, except live sessions' current runs and runs
 *  yian ended. */
import { expect, test } from "bun:test"
import path from "node:path"
import type { RunIndexRow, RunInspection, RunStatus } from "@ngocbh/yian/run"
import { Inspections, Live, YianRuns, statusOf, sweep } from "../../src/runs/records.ts"
import { DEBRIEF, OFFICE, OFFICE_STOPPED } from "../../src/runs/outcomes.ts"
import { SCHEMA } from "../../src/runs/reader.ts"
import { newId, type RunRow, type SessionRecord, type Store } from "../../src/store/store.ts"
import { tempDir } from "../helpers.ts"
import { openStore, session } from "../store/helpers.ts"

const T = "2026-10-20T10:00:00.000Z"

/** A row for each of `s`'s runs: flow "chat", driver ngocbh, created at T, overridden by `over`. */
function addRuns(store: Store, s: SessionRecord, over: Partial<RunRow> = {}): RunRow[] {
  return s.run_ids.map((runId) =>
    store.addRun({
      runId,
      sessionId: s.id,
      driver: "ngocbh",
      flow: "chat",
      flowPath: "shared/flows/chat.yaml",
      connection: null,
      model: null,
      configSha256: null,
      replacesRunId: null,
      createdAt: T,
      ...over,
    }),
  )
}

function indexRow(runId: string, status: RunStatus): RunIndexRow {
  return {
    runId,
    flow: "shared/flows/chat.yaml",
    status,
    startedAt: T,
    endedAt: status === "succeeded" ? T : null,
    parentRunId: null,
    lastSeq: 3,
    result: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    offset: 10,
    waits: [],
    ready: false,
    wakeAt: null,
  }
}

function inspection(status: RunStatus): RunInspection {
  return {
    status,
    inFlight: [],
    crashedAttempts: new Map(),
    runId: null,
    schema: SCHEMA,
    flowFingerprint: null,
    learnable: false,
    lastSeq: 3,
    startedAt: T,
    endedAt: T,
    failure: null,
    waits: [],
    ready: false,
    wakeAt: null,
  }
}

function noLog(): RunInspection {
  throw Object.assign(new Error("no such file"), { code: "ENOENT" })
}

/** yian's lookup over index `rows`, with `inspect` answering what asks a run's log. */
function yianOf(rows: RunIndexRow[] = [], inspect: (log: string) => RunInspection = noLog): YianRuns {
  return new YianRuns(new Map(rows.map((r) => [r.runId, r])), new Inspections(tempDir(), inspect))
}

test("the start sweep interrupts what an earlier office left open", () => {
  const store = openStore()
  const [replaced, current] = [newId(), newId()]
  const idle = store.createSession(session({ status: "idle", run_ids: [replaced, current] }))
  addRuns(store, idle)
  const ended = store.createSession(session({ status: "ended", run_ids: [newId()] }))
  const [killed] = addRuns(store, ended, { flow: DEBRIEF, flowPath: "shared/flows/debrief.yaml", driver: OFFICE })
  // Only composer sessions' current runs are kept: a live Codex session's run is swept.
  const codex = store.createSession(session({ harness: "codex", status: "idle", run_ids: [newId()] }))
  const [coded] = addRuns(store, codex)
  const yian = yianOf()

  expect(sweep(store, yian)).toEqual([replaced, killed!.runId, coded!.runId].sort())
  for (const [runId, s] of [[killed!.runId, ended], [replaced, idle], [coded!.runId, codex]] as const) {
    const got = store.getRun(runId)!
    expect([got.endReason, got.endedAt]).toEqual([OFFICE_STOPPED, null])
    expect(statusOf(got, s, new Live(), yian)).toMatchObject({
      status: "interrupted",
      reason: OFFICE_STOPPED,
      failedNode: null,
    })
  }
  expect(store.getRun(current)!.endReason).toBeNull() // the idle session sleeps; its run is still open
})

test("the start sweep leaves a resumed sessions current run to restore", () => {
  const store = openStore()
  const current = newId()
  // Mid-reply: restore resumes it under the same run.
  addRuns(store, store.createSession(session({ status: "busy", run_ids: [current] })))
  expect(sweep(store, yianOf())).toEqual([])
  expect(store.getRun(current)!.endReason).toBeNull()
})

test("the start sweep leaves a run yian ended to its outcome", () => {
  const store = openStore()
  const [done, stale, held, writing, lost] = [newId(), newId(), newId(), newId(), newId()]
  const s = store.createSession(session({ status: "ended", run_ids: [done, stale, held, writing, lost] }))
  addRuns(store, s)
  // The stale row is from before the run ended: an update after the office stopped failed. A running row or log
  // is one a writer holds now: it may still end the run, so the office end must not hide that.
  const rows = [indexRow(done, "succeeded"), indexRow(stale, "waiting"), indexRow(held, "running")]
  const yian = yianOf(rows, (log) => {
    const runId = path.basename(path.dirname(log))
    if (runId === stale) return inspection("succeeded")
    if (runId === writing) return inspection("running")
    throw new Error("damaged")
  })

  expect(sweep(store, yian)).toEqual([lost])
  for (const runId of [done, stale]) {
    const got = store.getRun(runId)!
    expect(got.endReason).toBeNull()
    expect(statusOf(got, s, new Live(), yian).status).toBe("finished")
  }
  for (const runId of [held, writing]) expect(store.getRun(runId)!.endReason).toBeNull()
  expect(store.getRun(lost)!.endReason).toBe(OFFICE_STOPPED)
})

/** The runs table: the office's facts about a launched run, an end reason written once, and no events. */
import { expect, test } from "bun:test"
import { sqliteErrorCode } from "@ngocbh/yian/platform"
import {
  DuplicateKey,
  NotFound,
  StoreError,
  newId,
  type RunRow,
  type SessionRecord,
} from "../../src/store/store.ts"
import { openStore, recordEvents, session, thrown } from "./helpers.ts"

const T = "2026-10-20T10:00:00.000Z"

/** An `addRun` input for a new run in session `s`: flow "chat", driver ngocbh, created at T, overridden by `over`. */
function launch(s: SessionRecord, over?: Partial<RunRow>): Omit<RunRow, "endReason" | "endedAt"> {
  return {
    runId: newId(),
    sessionId: s.id,
    flow: "chat",
    flowPath: "shared/flows/chat.yaml",
    driver: "ngocbh",
    createdAt: T,
    connection: null,
    model: null,
    configSha256: null,
    replacesRunId: null,
    ...over,
  }
}

test("a launch is stored", () => {
  const store = openStore()
  const s = store.createSession(session())
  const events = recordEvents(store)
  const row = store.addRun(launch(s))
  expect(store.getRun(row.runId)).toEqual(row)
  expect([row.endReason, row.endedAt]).toEqual([null, null])
  expect(events).toEqual([])
  expect(thrown(() => store.addRun(launch(s, { sessionId: newId() })))).toBeInstanceOf(NotFound)
  expect(thrown(() => store.addRun(launch(s, { runId: row.runId })))).toBeInstanceOf(DuplicateKey)
  // Any other constraint is a plain StoreError.
  const error = thrown(() =>
    store.transaction((tx) =>
      tx.insert("runs", { run_id: newId(), session_id: s.id, flow: "chat", flow_path: "x", created_at: T }),
    ),
  )
  expect(error).toBeInstanceOf(StoreError)
  expect(error).not.toBeInstanceOf(DuplicateKey)
  expect(error).not.toBeInstanceOf(NotFound)
})

test("a runs config is recorded at spawn", () => {
  const store = openStore()
  const s = store.createSession(session())
  const row = store.addRun(launch(s))
  store.setRunConfig(row.runId, { connection: "azure-2", model: "gpt-4o-mini", configSha256: "f".repeat(64) })
  const got = store.getRun(row.runId)!
  expect([got.connection, got.model, got.configSha256]).toEqual(["azure-2", "gpt-4o-mini", "f".repeat(64)])
  const unknown = newId()
  const error = thrown(() => store.setRunConfig(unknown, { connection: null, model: null, configSha256: null }))
  expect(error).toBeInstanceOf(NotFound)
  expect((error as Error).message).toBe(`no run ${unknown}`)
})

test("an end reason is written once and capped", () => {
  const store = openStore()
  const s = store.createSession(session())
  const row = store.addRun(launch(s))
  const events = recordEvents(store)
  expect(store.endRun(row.runId, "x".repeat(3000), T)).toBe(true)
  expect(store.endRun(row.runId, "again")).toBe(false)
  const got = store.getRun(row.runId)!
  expect([got.endReason!.length, got.endedAt]).toEqual([256, T])
  expect(got.endReason!.endsWith("…")).toBe(true)
  expect(store.endRun(newId(), "nope", T)).toBe(false)
  // Kept a little past what's shown.
  const other = store.addRun(launch(s))
  store.endRun(other.runId, "x".repeat(256))
  expect(store.getRun(other.runId)!.endReason).toBe("x".repeat(256))
  expect(events).toEqual([])
})

test("an end reason rolls back with its transaction", () => {
  const store = openStore()
  const s = store.createSession(session({ status: "busy" }))
  const row = store.addRun(launch(s))
  const error = thrown(() =>
    store.transaction(() => {
      store.updateSession(s.id, { status: "ended" })
      store.endRun(row.runId, "the office stopped")
      throw new Error("killed between the writes")
    }),
  )
  expect((error as Error).message).toBe("killed between the writes")
  expect(store.getSession(s.id)!.status).toBe("busy")
  expect(store.getRun(row.runId)!.endReason).toBeNull()
})

test("the sweep gives the listed runs its reason and no end time", () => {
  const store = openStore()
  const s = store.createSession(session())
  const [kept, swept, also, done] = [0, 1, 2, 3].map(() => store.addRun(launch(s))) as [RunRow, RunRow, RunRow, RunRow]
  store.endRun(done.runId, "finished", T)
  const events = recordEvents(store)
  const ids = store.sweepRuns([also.runId, swept.runId, done.runId, "nope"], "the office stopped")
  expect(ids).toEqual([swept.runId, also.runId].sort())
  for (const runId of [swept.runId, also.runId]) {
    const got = store.getRun(runId)!
    expect([got.endReason, got.endedAt]).toEqual(["the office stopped", null])
  }
  expect(store.getRun(done.runId)).toEqual({ ...done, endReason: "finished", endedAt: T })
  expect(store.getRun(kept.runId)).toEqual(kept)
  expect(store.getRun("nope")).toBeUndefined()
  expect(events).toEqual([])
  // The sweep cuts a long reason as endRun does.
  const long = store.addRun(launch(s))
  store.sweepRuns([long.runId], "x".repeat(1000))
  const reason = store.getRun(long.runId)!.endReason!
  expect([reason.length, reason.endsWith("…")]).toEqual([256, true])
})

test("rows by session and by id", () => {
  const store = openStore()
  const s = store.createSession(session())
  const top = store.addRun(launch(s))
  const next = store.addRun(launch(s))
  const earlier = store.addRun(launch(s, { createdAt: "2026-10-19T10:00:00.000Z" }))
  store.addRun(launch(store.createSession(session())))
  expect(store.runsOfSession(s.id).map((r) => r.runId)).toEqual([earlier.runId, top.runId, next.runId])
  expect(store.getRuns([top.runId, "nope"])).toEqual(new Map([[top.runId, top]]))
})

test("open runs are the rows with no end reason", () => {
  const store = openStore()
  const s = store.createSession(session())
  const [late, early, ended, swept] = ["R4", "R1", "R2", "R3"].map((runId) =>
    store.addRun(launch(s, { runId })),
  ) as [RunRow, RunRow, RunRow, RunRow]
  store.endRun(ended.runId, "finished", T)
  store.sweepRuns([swept.runId], "the office stopped")
  const other = store.addRun(launch(store.createSession(session()), { runId: "R0" }))
  expect(store.openRuns()).toEqual([other, early, late])
})

test("a runs usage is summed from its model calls", () => {
  const store = openStore()
  const s = store.createSession(session())
  for (let n = 0; n < 2; n++) store.recordUsage({ sessionId: s.id, runId: "run-a", model: "m", usd: 0.5 })
  expect(store.runUsageUsd("run-a")).toBe(1.0)
  expect(store.runUsageUsd("run-b")).toBe(0)
})

test("long id lists are read in one statement", () => {
  // A plain `IN (?, …)` list of this size throws on Bun's SQLite.
  const store = openStore()
  const s = store.createSession(session())
  const a = store.addRun(launch(s))
  const b = store.addRun(launch(s))
  const ids = Array.from({ length: 300_000 }, (_, i) => `run-${i}`)
  ids.push(a.runId, b.runId)
  expect(store.getRuns(ids)).toEqual(new Map([[a.runId, a], [b.runId, b]]))
})

test("an end time needs an end reason", () => {
  const store = openStore()
  const s = store.createSession(session())
  const insert = (endReason: string | null, endedAt: string | null) =>
    store.db
      .prepare(
        "INSERT INTO runs (run_id, session_id, driver, flow, flow_path, end_reason, ended_at, created_at) " +
          "VALUES (?, ?, 'ngocbh', 'chat', 'shared/flows/chat.yaml', ?, ?, ?)",
      )
      .run(newId(), s.id, endReason, endedAt, T)
  expect(sqliteErrorCode(thrown(() => insert(null, T)))).toBe(275)
  insert(null, null)
  insert("the office stopped", null)
  insert("finished", T)
})

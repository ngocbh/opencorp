/** The Run Logs list: top-level runs newest first with how many runs each started, filters that keep a parent whose
 *  child matches, search by any part of an id, a launch range read in SQL, one run's children paged the same way,
 *  and reasons shown as stored. Parents and yian's ends come from a fake run index. */
import { expect, test } from "bun:test"
import type { RunPage } from "@opencorp/protocol"
import type { RunIndexRow, RunInspection } from "@ngocbh/yian/run"
import { Inspections, Live, type LiveRun } from "../../src/runs/records.ts"
import { OFFICE_STOPPED, WORKER_STOPPED } from "../../src/runs/outcomes.ts"
import { SCHEMA } from "../../src/runs/reader.ts"
import { RunLogs } from "../../src/runs/service.ts"
import { NotFound, REASON_CHARS, newId, type RunRow, type Store } from "../../src/store/store.ts"
import { tempDir } from "../helpers.ts"
import { openStore, session } from "../store/helpers.ts"

const T = "2026-10-20T10:00:00.000Z"
const OLD = "2026-09-01T10:00:00.000Z"
const KEY = "conn-key-5f3a9c1e7b2d4a60"

/** The store, yian's run index (by run id) and the runs folder one test's list reads. */
interface Office {
  store: Store
  index: Map<string, RunIndexRow>
  runsDir: string
}

function office(): Office {
  return { store: openStore(), index: new Map(), runsDir: tempDir() }
}

function runsFor(o: Office, options: Partial<ConstructorParameters<typeof RunLogs>[0]> = {}): RunLogs {
  return new RunLogs({ store: o.store, runsDir: o.runsDir, index: () => o.index, ...options })
}

function launch(runId: string, sessionId: string, flow: string, driver: string, at: string) {
  return {
    runId,
    sessionId,
    driver,
    flow,
    flowPath: `shared/flows/${flow}.yaml`,
    connection: null,
    model: null,
    configSha256: null,
    replacesRunId: null,
    createdAt: at,
  } satisfies Omit<RunRow, "endReason" | "endedAt">
}

function indexRow(runId: string, over: Partial<RunIndexRow> = {}): RunIndexRow {
  return {
    runId,
    flow: "shared/flows/chat.yaml",
    status: "succeeded",
    startedAt: T,
    endedAt: null,
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
    ...over,
  }
}

function inspection(over: Partial<RunInspection> = {}): RunInspection {
  return {
    status: "crashed",
    inFlight: [],
    crashedAttempts: new Map(),
    runId: null,
    schema: SCHEMA,
    flowFingerprint: null,
    learnable: false,
    lastSeq: 3,
    startedAt: T,
    endedAt: null,
    failure: null,
    waits: [],
    ready: false,
    wakeAt: null,
    ...over,
  }
}

function noLog(): RunInspection {
  throw Object.assign(new Error("no such file"), { code: "ENOENT" })
}

function live(entries: Record<string, LiveRun>): Live {
  return new Live(new Map(Object.entries(entries)))
}

/** A main session's run launched `at`, ended with `outcome` (finished: yian's index says succeeded; failed: the
 *  office's end `reason`, "worker stopped" by default; interrupted: the office stopped), and `kids` side-chat runs
 *  under it in yian's index, driven by lan, launched `kidAt` (`at` by default), succeeded. */
function chatWith(
  o: Office,
  {
    kids = 0,
    driver = "ngocbh",
    outcome = "finished",
    reason,
    at = T,
    kidAt,
  }: { kids?: number; driver?: string; outcome?: string; reason?: string; at?: string; kidAt?: string } = {},
): string {
  const s = o.store.createSession(session({ status: "ended" }))
  const top = newId()
  o.store.addSessionRun(s.id, top)
  o.store.addRun(launch(top, s.id, "chat", driver, at))
  if (outcome === "finished") o.index.set(top, indexRow(top))
  else o.store.endRun(top, outcome === "interrupted" ? OFFICE_STOPPED : (reason ?? WORKER_STOPPED))
  for (let i = 0; i < kids; i++) {
    const side = o.store.createSession(session({ kind: "side", status: "ended" }))
    const kid = newId()
    o.store.addSessionRun(side.id, kid)
    o.store.addRun(launch(kid, side.id, "side_chat", "lan", kidAt ?? at))
    o.index.set(kid, indexRow(kid, { flow: "shared/flows/side_chat.yaml", parentRunId: top }))
  }
  return top
}

/** `top`'s children in yian's index, newest first. */
function kidsOf(o: Office, top: string): string[] {
  return [...o.index.values()]
    .filter((r) => r.parentRunId === top)
    .map((r) => r.runId)
    .sort()
    .reverse()
}

function ids(page: RunPage): string[] {
  return page.runs.map((r) => r.run_id)
}

/** Every run id `store.runPage` gives from now on. */
function scannedRows(store: Store): string[] {
  const scanned: string[] = []
  const pageOf = store.runPage.bind(store)
  store.runPage = (query) => {
    const rows = pageOf(query)
    scanned.push(...rows.map((r) => r.runId))
    return rows
  }
  return scanned
}

test("a page is top level runs newest first with how many runs each started", () => {
  const o = office()
  const first = chatWith(o, { kids: 2 })
  const second = chatWith(o)
  const page = runsFor(o).page()
  expect(ids(page)).toEqual([second, first])
  expect(page.next).toBeNull()
  expect(page.runs.map((r) => [r.children, r.children_total])).toEqual([
    [[], 0],
    [[], 2],
  ])
})

test("paging by top level run", () => {
  const o = office()
  const tops = [0, 1, 2].map(() => chatWith(o, { kids: 2 }))
  const runs = runsFor(o)
  const one = runs.page({ limit: 2 })
  expect([ids(one), one.next]).toEqual([[tops[2], tops[1]], tops[1]])
  const two = runs.page({ before: one.next, limit: 2 })
  expect([ids(two), two.next]).toEqual([[tops[0]], null])
  expect([...one.runs, ...two.runs].every((r) => r.children_total === 2)).toBe(true)
})

test("filters keep a parent whose child matches", () => {
  const o = office()
  const withSide = chatWith(o, { kids: 1 })
  const plain = chatWith(o)
  const failed = chatWith(o, { outcome: "failed" })
  const runs = runsFor(o)
  expect(ids(runs.page({ flow: "side_chat" }))).toEqual([withSide])
  expect(ids(runs.page({ person: "lan" }))).toEqual([withSide])
  expect(ids(runs.page({ person: "minh" }))).toEqual([failed, plain, withSide]) // the employee
  expect(ids(runs.page({ status: ["failed"] }))).toEqual([failed])
})

test("a status list matches any of them", () => {
  const o = office()
  const failed = chatWith(o, { outcome: "failed" })
  const finished = chatWith(o)
  chatWith(o, { outcome: "interrupted" })
  expect(ids(runsFor(o).page({ status: ["failed", "finished"] }))).toEqual([finished, failed])
})

test("the person filter matches the driver", () => {
  const o = office()
  const mine = chatWith(o, { driver: "lan" })
  chatWith(o, { driver: "kai" })
  expect(ids(runsFor(o).page({ person: "lan" }))).toEqual([mine])
})

test("search matches any part of a run id", () => {
  const o = office()
  const target = chatWith(o)
  chatWith(o)
  expect(ids(runsFor(o).page({ q: ` ${target.slice(-6).toLowerCase()} ` }))).toEqual([target])
})

test("a launch range is since inclusive and until exclusive", () => {
  const o = office()
  const at = [10, 11, 12, 13].map((d) => `2026-10-${d}T10:00:00.000Z`)
  const tops = at.map((t) => chatWith(o, { at: t }))
  const runs = runsFor(o)
  expect(ids(runs.page({ since: at[1], until: at[3] }))).toEqual([tops[2], tops[1]])
  expect(ids(runs.page({ since: at[3] }))).toEqual([tops[3]])
  expect(ids(runs.page({ until: at[1] }))).toEqual([tops[0]])
})

test("a launch range combines with filters and paging", () => {
  const o = office()
  const oldLan = chatWith(o, { driver: "lan", outcome: "failed", at: "2026-10-01T10:00:00.000Z" })
  const lan = [0, 1, 2].map(() => chatWith(o, { driver: "lan", outcome: "failed" }))
  chatWith(o, { driver: "kai", outcome: "failed" })
  chatWith(o, { driver: "lan" })
  const runs = runsFor(o)
  const wanted = { since: "2026-10-13T10:00:00.000Z", person: "lan", status: ["failed", "interrupted"], flow: "chat" }
  const one = runs.page({ ...wanted, limit: 2 })
  expect([ids(one), one.next]).toEqual([[lan[2], lan[1]], lan[1]])
  const two = runs.page({ ...wanted, before: one.next, limit: 2 })
  expect([ids(two), two.next]).toEqual([[lan[0]], null])
  expect(ids(runs.page({ ...wanted, q: lan[0]!.slice(-5) }))).toEqual([lan[0]])
  expect(ids(runs.page({ person: "lan", status: ["failed"], since: wanted.since }))).not.toContain(oldLan)
})

test("a parent launched before the range shows when a child in it matches", () => {
  const o = office()
  const top = chatWith(o, { kids: 1, at: "2026-10-13T10:00:00.000Z", kidAt: "2026-10-15T10:00:00.000Z" })
  const runs = runsFor(o)
  const since = "2026-10-14T00:00:00.000Z"
  expect(ids(runs.page({ since }))).toEqual([top])
  expect(ids(runs.page({ since, flow: "side_chat" }))).toEqual([top])
  expect(ids(runs.page({ since, person: "lan", status: ["finished"] }))).toEqual([top])
  expect(ids(runs.page({ since, flow: "chat" }))).toEqual([]) // the parent matches, but outside the range
  expect(ids(runs.page({ since, status: ["failed"] }))).toEqual([]) // the child is in range but doesn't match
  // A child outside the range doesn't show its parent.
  expect(ids(runs.page({ flow: "side_chat", until: "2026-10-14T10:00:00.000Z" }))).toEqual([])
  expect(ids(runs.page({ flow: "side_chat", since: "2026-10-13T00:00:00.000Z" }))).toEqual([top])
})

test("a seven day query over many old runs scans only the rows in range", () => {
  const o = office()
  const old = Array.from({ length: 30 }, () => chatWith(o, { at: OLD }))
  const oldParent = chatWith(o, { outcome: "failed", kids: 1, at: OLD, kidAt: T }) // a recent child
  const recent = [0, 1, 2].map(() => chatWith(o, { outcome: "failed" }))
  const newerOld = Array.from({ length: 30 }, () => chatWith(o, { at: "2026-09-02T10:00:00.000Z" })) // ids after
  const scanned = scannedRows(o.store)
  const wanted = { status: ["running", "waiting", "idle", "finished"], since: "2026-10-13T10:00:00.000Z" }
  const page = runsFor(o).page(wanted)
  expect([ids(page), page.next]).toEqual([[oldParent], null]) // its child finished in range
  // No other old row came out of the store.
  expect([...new Set(scanned)].sort()).toEqual([...recent, oldParent].sort())
  expect([old.length, newerOld.length]).toEqual([30, 30])
})

test("a filtered page stops after the scan cap and resumes", () => {
  const o = office()
  const target = chatWith(o, { outcome: "failed" })
  const plain = [0, 1, 2, 3, 4].map(() => chatWith(o))
  const runs = runsFor(o, { scanCap: 4, batch: 2 })
  const one = runs.page({ status: ["failed"] })
  expect([ids(one), one.next]).toEqual([[], plain[1]])
  expect(ids(runs.page({ status: ["failed"], before: one.next }))).toEqual([target])
})

test("one runs children page with the same filters", () => {
  const o = office()
  const top = chatWith(o, { kids: 3 })
  const kids = kidsOf(o, top)
  const runs = runsFor(o)
  const one = runs.children(top, { limit: 2 })
  expect([ids(one), one.next]).toEqual([kids.slice(0, 2), kids[1]])
  expect(one.runs.map((r) => [r.children, r.children_total])).toEqual([
    [[], 0],
    [[], 0],
  ])
  const two = runs.children(top, { before: one.next, limit: 2 })
  expect([ids(two), two.next]).toEqual([kids.slice(2), null])
  expect(ids(runs.children(top, { q: kids[1]!.slice(-6) }))).toEqual([kids[1]])
  expect(ids(runs.children(top, { flow: "chat" }))).toEqual([])
  expect(ids(runs.children(top, { since: "2026-10-21T00:00:00.000Z" }))).toEqual([])
  expect(() => runs.children(newId())).toThrow(NotFound)
})

test("a reason is shown as stored", () => {
  const o = office()
  const top = chatWith(o, { outcome: "failed", reason: `AuthError: Bearer abcdefgh12345 with ${KEY}` })
  const runs = runsFor(o)
  const [row] = runs.page().runs
  expect([row!.reason, row!.run_id]).toEqual([`AuthError: Bearer abcdefgh12345 with ${KEY}`, top])
  const side = o.store.createSession(session({ kind: "side", status: "ended" }))
  const kid = o.store.addRun(launch(newId(), side.id, "side_chat", "lan", T))
  o.index.set(kid.runId, indexRow(kid.runId, { status: "failed", parentRunId: top }))
  o.store.endRun(kid.runId, `leaked ${KEY}`)
  const [child] = runs.children(top).runs
  expect(child!.reason).toBe(`leaked ${KEY}`)
})

test("the list never opens a log", () => {
  const o = office()
  chatWith(o, { kids: 1 })
  chatWith(o, { outcome: "failed" })
  const asked: string[] = []
  const inspections = new Inspections(o.runsDir, (log) => {
    asked.push(log)
    return noLog()
  })
  const runs = runsFor(o, { inspections })
  runs.page({ status: ["finished"] })
  runs.children(runs.page().runs[1]!.run_id)
  expect(asked).toEqual([])
})

test("a run that finishes while listed shows running not interrupted", () => {
  const o = office()
  const s = o.store.createSession(session({ status: "busy" }))
  const runId = newId()
  o.store.addSessionRun(s.id, runId)
  o.store.addRun(launch(runId, s.id, "chat", "ngocbh", T))
  let memory = live({ [runId]: { status: "running", nodes: [] } })
  let ended = false
  // yian's index was read before the end; its log records it.
  const inspections = new Inspections(o.runsDir, () => (ended ? inspection({ status: "succeeded" }) : noLog()))
  const realPage = o.store.runPage.bind(o.store)
  o.store.runPage = (query) => {
    const rows = realPage(query)
    if (memory.runs.size > 0) {
      // The run ends after the rows were read: memory drops it, the session ends and yian's log has its end.
      memory = new Live()
      o.store.updateSession(s.id, { status: "ended" })
      ended = true
    }
    return rows
  }
  const page = runsFor(o, { live: () => memory, inspections }).page()
  expect(page.runs.map((r) => r.status)).toEqual(["running"])
})

test("a run that starts while listed shows running not interrupted", () => {
  const o = office()
  const s = o.store.createSession(session({ status: "starting" }))
  const runId = newId()
  o.store.addSessionRun(s.id, runId)
  o.store.addRun(launch(runId, s.id, "chat", "ngocbh", T))
  let memory = new Live()
  const realPage = o.store.runPage.bind(o.store)
  o.store.runPage = (query) => {
    if (memory.runs.size === 0) {
      // After memory was read, before the store reads: the actor takes the run, then busy.
      memory = live({ [runId]: { status: "running", nodes: [] } })
      o.store.updateSession(s.id, { status: "busy" })
    }
    return realPage(query)
  }
  const page = runsFor(o, { live: () => memory }).page()
  expect(page.runs.map((r) => r.status)).toEqual(["running"])
})

test("children are read only when they can match", () => {
  const o = office()
  const top = chatWith(o, { kids: 1 })
  const side = o.store.createSession(session({ kind: "side", status: "ended" }))
  const openKid = o.store.addRun(launch(newId(), side.id, "side_chat", "kai", T))
  o.index.set(openKid.runId, indexRow(openKid.runId, { status: "crashed", parentRunId: top }))
  const asked: unknown[] = []
  const real = o.store.runsAmong.bind(o.store)
  o.store.runsAmong = (runIds, filters = {}) => {
    const { since, until, recent, openOnly } = filters
    asked.push({ ids: [...runIds].sort(), since, until, recent, openOnly })
    return real(runIds, filters)
  }
  const runs = runsFor(o)
  // Its run has no end and nothing runs it: interrupted.
  expect(ids(runs.page({ status: ["running", "idle"], person: "kai" }))).toEqual([])
  expect(ids(runs.page({ status: ["interrupted"], person: "kai", since: "2026-10-13T00:00:00.000Z" }))).toEqual([top])
  const kids = kidsOf(o, top).sort()
  expect(asked).toEqual([
    { ids: kids, since: null, until: null, recent: null, openOnly: true },
    { ids: kids, since: "2026-10-13T00:00:00.000Z", until: null, recent: null, openOnly: false },
  ])
})

test("a reason longer than shown is cut", () => {
  const o = office()
  const top = chatWith(o, { outcome: "failed", reason: "z".repeat(186) + KEY }) // the key runs from 186 to 211
  const [row] = runsFor(o).page().runs
  expect([row!.reason, row!.run_id]).toEqual([("z".repeat(186) + KEY).slice(0, REASON_CHARS - 1) + "…", top])
})

test("open or recent lists open runs of any age and runs launched since", () => {
  const o = office()
  const oldOpenSession = o.store.createSession(session({ status: "idle" }))
  const oldOpen = newId()
  o.store.addSessionRun(oldOpenSession.id, oldOpen)
  o.store.addRun(launch(oldOpen, oldOpenSession.id, "chat", "ngocbh", OLD))
  // No end, but nothing runs it: interrupted, not open.
  const lost = o.store.createSession(session({ status: "ended" }))
  o.store.addRun(launch(newId(), lost.id, "chat", "ngocbh", OLD))
  chatWith(o, { at: OLD }) // old and closed
  const oldParent = chatWith(o, { kids: 1, at: OLD, kidAt: T })
  const recent = chatWith(o, { outcome: "failed" })
  const runs = runsFor(o, { live: () => live({ [oldOpen]: { status: "idle", nodes: [] } }) })
  const since = "2026-10-13T10:00:00.000Z"
  expect(ids(runs.page({ recent: since }))).toEqual([recent, oldParent, oldOpen])
  expect(ids(runs.page({ recent: since, status: ["idle"] }))).toEqual([oldOpen])
  expect(ids(runs.page({ recent: since, person: "lan" }))).toEqual([oldParent])
  expect(ids(runs.page({ recent: since, flow: "chat", status: ["finished"] }))).toEqual([]) // oldParent: not recent
  const one = runs.page({ recent: since, limit: 2 })
  expect([ids(one), one.next]).toEqual([[recent, oldParent], oldParent])
  expect(ids(runs.page({ recent: since, before: one.next }))).toEqual([oldOpen])
  const [kid] = kidsOf(o, oldParent)
  expect(ids(runs.children(oldParent, { recent: since }))).toEqual([kid])
  expect(ids(runs.children(oldParent, { recent: "2026-10-21T00:00:00.000Z" }))).toEqual([])
})

test("the default first request scans only open and recent runs", () => {
  const o = office()
  const oldClosed = Array.from({ length: 30 }, () => chatWith(o, { at: OLD }))
  const s = o.store.createSession(session({ status: "waiting" }))
  const oldOpen = newId()
  o.store.addSessionRun(s.id, oldOpen)
  o.store.addRun(launch(oldOpen, s.id, "chat", "ngocbh", OLD))
  const recent = [0, 1, 2].map(() => chatWith(o, { outcome: "failed" }))
  const newerClosed = Array.from({ length: 30 }, () => chatWith(o, { at: "2026-09-02T10:00:00.000Z" })) // ids after
  const scanned = scannedRows(o.store)
  const runs = runsFor(o, { live: () => live({ [oldOpen]: { status: "waiting", nodes: [] } }) })
  const page = runs.page({ recent: "2026-10-13T10:00:00.000Z", limit: 50 })
  expect([ids(page), page.next]).toEqual([[...recent].reverse().concat(oldOpen), null])
  expect([...new Set(scanned)].sort()).toEqual([...recent, oldOpen].sort())
  expect([oldClosed.length, newerClosed.length]).toEqual([30, 30])
})

test("recent open means running waiting or idle not merely no outcome", () => {
  const o = office()
  /** A run with no end whose session ended: it reads as interrupted ("ended without a recorded outcome"). */
  const lost = (at: string) => {
    const s = o.store.createSession(session({ status: "ended" }))
    const runId = newId()
    o.store.addSessionRun(s.id, runId)
    o.store.addRun(launch(runId, s.id, "chat", "ngocbh", at))
    return runId
  }
  const old = lost(OLD)
  const inRange = lost(T)
  const page = runsFor(o).page({ recent: "2026-10-13T10:00:00.000Z" })
  expect(ids(page)).toEqual([inRange])
  expect(ids(page)).not.toContain(old)
  expect(page.runs[0]!.status).toBe("interrupted")
})

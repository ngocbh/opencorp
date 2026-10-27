/** Run status, current nodes and participants: from office rows, the actor's memory and yian's index and logs. */
import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { openSqlite } from "@ngocbh/yian/platform"
import { type RunIndexRow, type RunInspection, updateRunIndex, type WaitInfo } from "@ngocbh/yian/run"
import {
  CANCELLED,
  Inspections,
  Live,
  type LiveRun,
  NO_OUTCOME,
  STOPPED,
  Summaries,
  YianRuns,
  currentNodes,
  participants,
  readIndex,
  statusOf,
} from "../../src/runs/records.ts"
import { CARD_CLOSED, WORKER_STOPPED } from "../../src/runs/outcomes.ts"
import { SCHEMA } from "../../src/runs/reader.ts"
import { newId, type RunRow, type SessionRecord } from "../../src/store/store.ts"
import { tempDir } from "../helpers.ts"
import { openStore, question, session } from "../store/helpers.ts"
import { committed, RUN, runStarted, started, succeeded } from "./helpers.ts"

const T = "2026-10-20T10:00:00.000Z"

function row(s: SessionRecord, runId: string, over: Partial<RunRow> = {}): RunRow {
  return {
    runId,
    sessionId: s.id,
    driver: "ngocbh",
    flow: "chat",
    flowPath: "shared/flows/chat.yaml",
    connection: null,
    model: null,
    configSha256: null,
    endReason: null,
    endedAt: null,
    replacesRunId: null,
    createdAt: T,
    ...over,
  }
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

function wait(node: string): WaitInfo {
  return { node, callId: "c1", tool: "take", inbox: "messages", deadline: null, settled: false }
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

/** yian's lookup over `rows`, each with a log of exactly `offset` bytes (so the row is fresh) unless its run id is
 *  in `stale`, and `inspect` answering what asks the log. */
function yianOf(
  rows: RunIndexRow[],
  inspect: (log: string) => RunInspection = noLog,
  stale: string[] = [],
): YianRuns {
  const runsDir = tempDir()
  for (const r of rows) {
    fs.mkdirSync(path.join(runsDir, r.runId))
    const size = stale.includes(r.runId) ? r.offset + 1 : r.offset
    fs.writeFileSync(path.join(runsDir, r.runId, "log.jsonl"), "x".repeat(size))
  }
  return new YianRuns(new Map(rows.map((r) => [r.runId, r])), new Inspections(runsDir, inspect))
}

const none = () => yianOf([])

function live(entries: Record<string, LiveRun>): Live {
  return new Live(new Map(Object.entries(entries)))
}

test("the outcome wins", () => {
  const s = session({ status: "idle", run_ids: ["R"] })
  const memory = live({ R: { status: "idle", nodes: [] } })
  const out = statusOf(row(s, "R", { endReason: WORKER_STOPPED }), s, memory, none())
  expect(out).toMatchObject({ status: "failed", reason: "worker stopped", failedNode: null })
})

test("a waiting or idle sessions current run has its status awake or asleep", () => {
  for (const st of ["idle", "waiting"] as const) {
    const s = session({ status: st, run_ids: ["R"] })
    expect(statusOf(row(s, "R"), s, live({ R: { status: st, nodes: [] } }), none())).toMatchObject({
      status: st,
      reason: null,
      failedNode: null,
    })
  }
  const s = session({ status: "idle", run_ids: ["R"] })
  const asleep = (node: string) =>
    statusOf(row(s, "R"), s, new Live(), yianOf([indexRow("R", { status: "waiting", waits: [wait(node)] })])).status
  expect(asleep("chat#3/heard")).toBe("idle")
  expect(asleep("chat#3/setup")).toBe("waiting")
})

test("a busy sessions current run runs only with its live run or wake", () => {
  const s = session({ status: "busy", run_ids: ["R"] })
  expect(statusOf(row(s, "R"), s, live({ R: { status: "running", nodes: [] } }), none()).status).toBe("running")
  expect(statusOf(row(s, "R"), s, live({ OTHER: { status: "running", nodes: [] } }), none())).toMatchObject({
    status: "interrupted",
    reason: NO_OUTCOME,
    failedNode: null,
  })
  expect(statusOf(row(s, "R"), s, new Live(), none())).toMatchObject({
    status: "interrupted",
    reason: NO_OUTCOME,
    failedNode: null,
  })
})

test("a starting sessions current run is running", () => {
  const s = session({ status: "starting", run_ids: ["R"] })
  expect(statusOf(row(s, "R"), s, live({ R: { status: "running", nodes: [] } }), none())).toMatchObject({
    status: "running",
    reason: null,
    failedNode: null,
  })
})

test("an earlier run of a live session with no outcome is interrupted", () => {
  const s = session({ status: "idle", run_ids: ["OLD", "NEW"] })
  const memory = live({ OLD: { status: "idle", nodes: [] }, NEW: { status: "idle", nodes: [] } })
  expect(statusOf(row(s, "OLD"), s, memory, none())).toMatchObject({
    status: "interrupted",
    reason: NO_OUTCOME,
    failedNode: null,
  })
})

test("current nodes by status", () => {
  const sid = newId()
  const card = question(sid, { run_id: "R", source: "ask", node_id: "chat#3/setup" })
  const asked = question(sid, { run_id: "R" }) // ask_user: no node
  const busy = live({ R: { status: "running", nodes: ["chat#3/reply"] } })
  const replyWaits = live({ R: { status: "waiting", nodes: ["chat#3/reply"] } })
  expect(currentNodes("idle", "R", [], new Live(), [wait("chat#3/heard")])).toEqual({
    nodes: ["chat#3/heard"],
    asking: false,
    held: false,
  })
  expect(currentNodes("waiting", "R", [card], new Live(), [wait("chat#3/setup")])).toEqual({
    nodes: ["chat#3/setup"],
    asking: false,
    held: false,
  })
  expect(currentNodes("waiting", "R", [asked], replyWaits, [])).toEqual({
    nodes: ["chat#3/reply"],
    asking: true,
    held: false,
  })
  expect(currentNodes("waiting", "R", [], new Live(), [])).toEqual({ nodes: [], asking: false, held: true })
  expect(currentNodes("running", "R", [], busy, [])).toEqual({ nodes: ["chat#3/reply"], asking: false, held: false })
  expect(currentNodes("finished", "R", [card], busy, [wait("chat#3/heard")])).toEqual({
    nodes: [],
    asking: false,
    held: false,
  })
})

test("participants put the employee first and never the driver", () => {
  expect(participants("ngocbh", "minh", ["ngocbh", "lan", null, "lan", "kai"])).toEqual(["minh", "lan", "kai"])
})

test("a succeeded run shows finished", () => {
  const s = session({ status: "ended", run_ids: ["R"] })
  expect(statusOf(row(s, "R"), s, new Live(), yianOf([indexRow("R", { status: "succeeded" })]))).toMatchObject({
    status: "finished",
    reason: null,
    failedNode: null,
  })
})

test("a failed run shows failed with yians failure and node", () => {
  const s = session({ status: "ended", run_ids: ["R"] })
  const failure = { message: "x".repeat(300), nodeId: "chat#3/reply" } as RunInspection["failure"]
  const yian = yianOf([indexRow("R", { status: "failed" })], () => inspection({ status: "failed", failure }))
  const out = statusOf(row(s, "R"), s, new Live(), yian)
  expect(out.status).toBe("failed")
  expect(out.failedNode).toBe("chat#3/reply")
  expect(out.reason).toHaveLength(200)
  expect(out.reason!.endsWith("…")).toBe(true)
})

test("a stopped run shows interrupted stopped", () => {
  const s = session({ status: "ended", run_ids: ["R"] })
  expect(statusOf(row(s, "R"), s, new Live(), yianOf([indexRow("R", { status: "stopped" })]))).toMatchObject({
    status: "interrupted",
    reason: STOPPED,
    failedNode: null,
  })
  // A fresh row's log isn't read again, whatever it would say.
  const fresh = yianOf([indexRow("R", { status: "stopped" })], () => inspection({ status: "succeeded" }))
  expect(statusOf(row(s, "R"), s, new Live(), fresh)).toMatchObject({
    status: "interrupted",
    reason: STOPPED,
    failedNode: null,
  })
})

test("a waiting run shows idle when only its turn waits and waiting otherwise", () => {
  const s = session({ status: "idle", run_ids: ["R"] })
  const shown = (waits: WaitInfo[]) =>
    statusOf(row(s, "R"), s, new Live(), yianOf([indexRow("R", { status: "waiting", waits })])).status
  expect(shown([wait("chat#3/heard")])).toBe("idle")
  expect(shown([wait("chat#3/heard"), wait("chat#3/setup")])).toBe("waiting")
  expect(shown([])).toBe("waiting")
})

test("a cancelled run shows interrupted with the office reason", () => {
  const s = session({ status: "ended", run_ids: ["R"] })
  const yian = yianOf([indexRow("R", { status: "cancelled" })])
  expect(statusOf(row(s, "R", { endReason: CARD_CLOSED }), s, new Live(), yian)).toMatchObject({
    status: "interrupted",
    reason: CARD_CLOSED,
    failedNode: null,
  })
  expect(statusOf(row(s, "R"), s, new Live(), yian)).toMatchObject({
    status: "interrupted",
    reason: CANCELLED,
    failedNode: null,
  })
})

test("a crashed running or missing index row asks the log and else has no outcome", () => {
  const s = session({ status: "ended", run_ids: ["R"] })
  const rows = [[indexRow("R", { status: "crashed" })], [indexRow("R", { status: "running" })], []]
  for (const rs of rows) {
    const asks = (inspect: (log: string) => RunInspection) => statusOf(row(s, "R"), s, new Live(), yianOf(rs, inspect))
    expect(asks(() => inspection({ status: "succeeded" })).status).toBe("finished")
    expect(asks(() => inspection({ status: "crashed" }))).toMatchObject({
      status: "interrupted",
      reason: NO_OUTCOME,
      failedNode: null,
    })
    expect(asks(noLog)).toMatchObject({ status: "interrupted", reason: NO_OUTCOME, failedNode: null })
  }
})

test("an ended runs inspection is read once", () => {
  const runsDir = tempDir()
  for (const [status, reads] of [["failed", 1], ["crashed", 2]] as const) {
    const logs: string[] = []
    const inspections = new Inspections(runsDir, (log) => {
      logs.push(log)
      return inspection({ status })
    })
    expect(inspections.get("R")!.status).toBe(status)
    expect(inspections.get("R")!.status).toBe(status)
    expect(logs).toEqual(Array(reads).fill(path.join(runsDir, "R", "log.jsonl")))
  }
})

test("a stale waiting or stopped row asks the log", () => {
  const s = session({ status: "ended", run_ids: ["R"] })
  for (const status of ["stopped", "waiting"] as const) {
    const yian = yianOf([indexRow("R", { status })], () => inspection({ status: "succeeded" }), ["R"])
    expect(statusOf(row(s, "R"), s, new Live(), yian).status).toBe("finished")
  }
  // No log file at all counts as stale too.
  const index = new Map([["R", indexRow("R", { status: "waiting" })]])
  const missing = new YianRuns(index, new Inspections(tempDir(), () => inspection({ status: "succeeded" })))
  expect(statusOf(row(s, "R"), s, new Live(), missing).status).toBe("finished")
})

test("a run with no outcome is warned about once", () => {
  const s = session({ status: "ended" })
  const runId = newId()
  const lines: string[] = []
  const log = (line: string) => lines.push(line)
  statusOf(row(s, runId), s, new Live(), none(), log)
  statusOf(row(s, runId), s, new Live(), none(), log)
  expect(lines).toEqual([`run ${runId} has no recorded outcome and nothing runs it`])
})

test("reading the index logs its warnings by path and an unreadable index is empty", () => {
  const runsDir = tempDir()
  const other = RUN.replace(/R1$/, "R2")
  for (const id of [RUN, other]) {
    fs.mkdirSync(path.join(runsDir, id))
    const records = [runStarted(0), started(1, "a"), committed(2, "a", {}), succeeded(3, "a", 2)]
    fs.writeFileSync(path.join(runsDir, id, "log.jsonl"), Buffer.concat(records).toString().replaceAll(RUN, id))
  }
  updateRunIndex(runsDir)
  const db = openSqlite(path.join(runsDir, "index.sqlite"))
  db.prepare("UPDATE runs SET scan = ? WHERE run_id = ?").run("not a scan", RUN)
  db.close()
  const lines: string[] = []
  expect([...readIndex(runsDir, (line) => lines.push(line)).keys()]).toEqual([other])
  expect(lines).toEqual([`run index skipped ${path.join(runsDir, RUN, "log.jsonl")}`])

  const garbage = tempDir()
  fs.writeFileSync(path.join(garbage, "index.sqlite"), "not a database, just some text that is long enough")
  lines.length = 0
  expect(readIndex(garbage, (line) => lines.push(line)).size).toBe(0)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatch(/^run index read failed \([A-Za-z]+\)$/)
})

test("participants come from answers and side chat openers", () => {
  const store = openStore()
  const s = store.createSession(session({ status: "idle" }))
  const top = newId()
  store.addSessionRun(s.id, top)
  store.addRun(row(s, top))
  const q = store.addQuestion(question(s.id, { run_id: top, source: "ask", node_id: "chat#0/setup" }))
  store.answerQuestion(q.id, "hi", "text", "kai")
  const side = store.createSession(session({ kind: "side", status: "ended" }))
  const kid = newId()
  store.addSessionRun(side.id, kid)
  store.addRun(row(side, kid, { flow: "side_chat", driver: "lan" }))
  const yian = yianOf([indexRow(top), indexRow(kid, { parentRunId: top })])
  const memory = live({ [top]: { status: "idle", nodes: [] } })
  const summaries = new Summaries(store, memory, yian)
  const built = summaries.build([store.getRun(top)!])
  const one = built.get(top)!
  expect([one.participants, one.children_total, one.children]).toEqual([["minh", "kai", "lan"], 1, []])
  const shown = summaries.build([store.getRun(top)!], { children: summaries.children([top]) })
  expect(shown.get(top)!.children!.map((k) => k.participants)).toEqual([["minh"]])
  expect(shown.get(top)!.children![0]!.parent_run_id).toBe(top)
})

test("children are counted and the newest shown", () => {
  const store = openStore()
  const s = store.createSession(session({ status: "ended" }))
  const top = newId()
  store.addRun(row(s, top))
  const kids: string[] = []
  for (let i = 0; i < 3; i++) {
    const side = store.createSession(session({ kind: "side", status: "ended" }))
    kids.push(store.addRun(row(side, newId(), { flow: "side_chat" })).runId)
  }
  const yian = yianOf([indexRow(top), ...kids.map((k) => indexRow(k, { parentRunId: top }))])
  const summaries = new Summaries(store, new Live(), yian, { childrenShown: 2 })
  const built = summaries.build([store.getRun(top)!], { children: summaries.children([top]) })
  expect(built.get(top)!.children!.map((k) => k.run_id)).toEqual([kids[2], kids[1]])
  expect(built.get(top)!.children_total).toBe(3)
})

test("a fresh run replaces the run whose end is its launch", () => {
  const store = openStore()
  const s = store.createSession(session({ status: "idle" }))
  const [a, b] = [newId(), newId()]
  for (const runId of [a, b]) store.addSessionRun(s.id, runId)
  store.addRun(row(s, a))
  store.endRun(a, WORKER_STOPPED, T)
  store.addRun(row(s, b, { replacesRunId: a }))
  const memory = live({ [b]: { status: "idle", nodes: [] } })
  const built = new Summaries(store, memory, none()).build(store.runsOfSession(s.id))
  const [ra, rb] = [built.get(a)!, built.get(b)!]
  expect([ra.replaced_by, rb.replaces, ra.replaces, rb.replaced_by]).toEqual([b, a, null, null])
  expect([ra.status, rb.status]).toEqual(["failed", "idle"])
})

test("a reopened side chat doesnt replace its earlier run", () => {
  const store = openStore()
  const side = store.createSession(session({ kind: "side", status: "idle" }))
  const [a, b] = [newId(), newId()]
  for (const runId of [a, b]) store.addSessionRun(side.id, runId)
  store.addRun(row(side, a, { flow: "side_chat" }))
  store.addRun(row(side, b, { flow: "side_chat", createdAt: "2026-10-20T10:09:00.000Z" }))
  const yian = yianOf([indexRow(a, { endedAt: "2026-10-20T10:05:00.000Z" })])
  const built = new Summaries(store, new Live(), yian).build(store.runsOfSession(side.id))
  expect([built.get(b)!.replaces, built.get(a)!.replaced_by]).toEqual([null, null])
  expect(built.get(a)!.ended_at).toBe("2026-10-20T10:05:00.000Z")
})

test("a run whose end only its log shows has the logs end time", () => {
  const store = openStore()
  const s = store.createSession(session({ status: "ended" }))
  const runId = newId()
  store.addSessionRun(s.id, runId)
  store.addRun(row(s, runId))
  const end = "2026-10-20T10:07:00.000Z"
  const shown = (yian: YianRuns) => new Summaries(store, new Live(), yian).build([store.getRun(runId)!]).get(runId)!
  const ended = (status: "succeeded" | "failed") => () => inspection({ status, endedAt: end })
  for (const rows of [[indexRow(runId, { status: "running" })], []]) {
    const one = shown(yianOf(rows, ended("succeeded")))
    expect([one.status, one.ended_at]).toEqual(["finished", end])
  }
  const stale = shown(yianOf([indexRow(runId, { status: "stopped" })], ended("failed"), [runId]))
  expect([stale.status, stale.ended_at]).toEqual(["failed", end])
})

test("two live reads merge so a run live in either is live", () => {
  const first = live({ R1: { status: "running", nodes: ["a"] }, X: { status: "running", nodes: [] } })
  const later = live({ R1: { status: "idle", nodes: ["n"] }, R2: { status: "waiting", nodes: [] } })
  const both = first.merged(later)
  expect(Object.fromEntries([...both.runs].map(([id, r]) => [id, r.status]))).toEqual({
    R1: "idle",
    X: "running",
    R2: "waiting",
  })
  expect(both.nodes("R1")).toEqual(["n"])
})

test("a build reads memory again after the store", () => {
  const store = openStore()
  const s = store.createSession(session({ status: "busy" }))
  const runId = newId()
  store.addSessionRun(s.id, runId)
  store.addRun(row(s, runId))
  const reads: string[] = []
  const fresh = () => {
    reads.push("fresh")
    return live({ [runId]: { status: "running", nodes: [] } })
  }
  const built = new Summaries(store, new Live(), none(), { fresh }).build([store.getRun(runId)!])
  expect(built.get(runId)!.status).toBe("running")
  expect(reads).toEqual(["fresh"])
})

test("a long stored reason is cut to be shown", () => {
  const store = openStore()
  const s = store.createSession(session({ status: "ended" }))
  const runId = newId()
  store.addRun(row(s, runId))
  store.endRun(runId, "x".repeat(1500))
  expect(store.getRun(runId)!.endReason).toHaveLength(256)
  const [built] = new Summaries(store, new Live(), none()).build([store.getRun(runId)!]).values()
  expect(built!.reason).toHaveLength(200)
  expect(built!.reason!.endsWith("…")).toBe(true)
})

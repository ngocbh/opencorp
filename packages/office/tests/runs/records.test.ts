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
  YianRuns,
  currentNodes,
  participants,
  readIndex,
  statusOf,
} from "../../src/runs/records.ts"
import { CARD_CLOSED, WORKER_STOPPED } from "../../src/runs/outcomes.ts"
import { newId, type RunRow, type SessionRecord } from "../../src/store/store.ts"
import { tempDir } from "../helpers.ts"
import { question, session } from "../store/helpers.ts"
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
    schema: 22,
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
  expect(out).toEqual({ status: "failed", reason: "worker stopped", failedNode: null })
})

test("a waiting or idle sessions current run has its status awake or asleep", () => {
  for (const st of ["idle", "waiting"] as const) {
    const s = session({ status: st, run_ids: ["R"] })
    expect(statusOf(row(s, "R"), s, live({ R: { status: st, nodes: [] } }), none())).toEqual({
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
  expect(statusOf(row(s, "R"), s, live({ OTHER: { status: "running", nodes: [] } }), none())).toEqual({
    status: "interrupted",
    reason: NO_OUTCOME,
    failedNode: null,
  })
  expect(statusOf(row(s, "R"), s, new Live(), none())).toEqual({
    status: "interrupted",
    reason: NO_OUTCOME,
    failedNode: null,
  })
})

test("a starting sessions current run is running", () => {
  const s = session({ status: "starting", run_ids: ["R"] })
  expect(statusOf(row(s, "R"), s, live({ R: { status: "running", nodes: [] } }), none())).toEqual({
    status: "running",
    reason: null,
    failedNode: null,
  })
})

test("an earlier run of a live session with no outcome is interrupted", () => {
  const s = session({ status: "idle", run_ids: ["OLD", "NEW"] })
  const memory = live({ OLD: { status: "idle", nodes: [] }, NEW: { status: "idle", nodes: [] } })
  expect(statusOf(row(s, "OLD"), s, memory, none())).toEqual({
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
  expect(statusOf(row(s, "R"), s, new Live(), yianOf([indexRow("R", { status: "succeeded" })]))).toEqual({
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
  expect(statusOf(row(s, "R"), s, new Live(), yianOf([indexRow("R", { status: "stopped" })]))).toEqual({
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
  expect(statusOf(row(s, "R", { endReason: CARD_CLOSED }), s, new Live(), yian)).toEqual({
    status: "interrupted",
    reason: CARD_CLOSED,
    failedNode: null,
  })
  expect(statusOf(row(s, "R"), s, new Live(), yian)).toEqual({
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
    expect(asks(() => inspection({ status: "crashed" }))).toEqual({
      status: "interrupted",
      reason: NO_OUTCOME,
      failedNode: null,
    })
    expect(asks(noLog)).toEqual({ status: "interrupted", reason: NO_OUTCOME, failedNode: null })
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

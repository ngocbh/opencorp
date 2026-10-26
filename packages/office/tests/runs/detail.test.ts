/** One run's page from its yian log: the header, log states, nodes with their kinds, records and the download, as
 *  stored; and the run's run.updated. Store rows, a fake run index and real or synthetic logs stand in for the chat
 *  harness. */
import fs from "node:fs"
import path from "node:path"
import type { Readable } from "node:stream"
import { expect, test } from "bun:test"
import type { RunIndexRow, RunInspection } from "@ngocbh/yian/run"
import { COULDNT_START } from "../../src/runs/outcomes.ts"
import { refresh, RunLogReader, UnreadableLog, UnsupportedSchema } from "../../src/runs/reader.ts"
import { Inspections, Live, type LiveRun } from "../../src/runs/records.ts"
import { LOG_GONE, NoLog, NOT_STARTED, NOT_STARTED_YET, RunLogs } from "../../src/runs/service.ts"
import { NotFound, newId, type RunRow, type Store } from "../../src/store/store.ts"
import { tempDir } from "../helpers.ts"
import { openStore, session } from "../store/helpers.ts"
import {
  chatLog,
  committed,
  line,
  LOOP_FLOW,
  realRun,
  RUN,
  runStarted,
  started,
  succeeded,
} from "./helpers.ts"

const T = "2026-10-20T10:00:00.000Z"
const KEY = "conn-key-5f3a9c1e7b2d4a60"

/** The store, yian's run index (by run id), the actor's memory and the runs folder one test's pages read. */
interface Office {
  store: Store
  index: Map<string, RunIndexRow>
  live: Map<string, LiveRun>
  runsDir: string
}

function office(runsDir = tempDir()): Office {
  return { store: openStore(), index: new Map(), live: new Map(), runsDir }
}

function runsFor(o: Office, options: Partial<ConstructorParameters<typeof RunLogs>[0]> = {}): RunLogs {
  return new RunLogs({
    store: o.store,
    runsDir: o.runsDir,
    index: () => o.index,
    live: () => new Live(new Map(o.live)),
    ...options,
  })
}

function indexRow(runId: string, over: Partial<RunIndexRow> = {}): RunIndexRow {
  return {
    runId,
    flow: "shared/flows/chat.yaml",
    status: "waiting",
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

/** A run row of a new session of `kind` (its only run), flow chat or side_chat by kind. */
function aRun(o: Office, { runId = newId(), kind = "main" }: { runId?: string; kind?: "main" | "side" } = {}): RunRow {
  const s = o.store.createSession(session({ kind }))
  o.store.addSessionRun(s.id, runId)
  const flow = kind === "main" ? "chat" : "side_chat"
  return o.store.addRun({
    runId,
    sessionId: s.id,
    driver: "ngocbh",
    flow,
    flowPath: `shared/flows/${flow}.yaml`,
    connection: null,
    model: null,
    configSha256: null,
    replacesRunId: null,
    createdAt: T,
  })
}

/** `runId`'s log file, its folder made. */
function logFile(o: Office, runId: string): string {
  const file = path.join(o.runsDir, runId, "log.jsonl")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  return file
}

/** A chat run idle at its next turn, its log a synthetic chat of two turns, its index row with 6 tokens in. */
function chat(o: Office): RunRow {
  const row = aRun(o, { runId: RUN })
  chatLog(logFile(o, RUN))
  o.index.set(RUN, indexRow(RUN, { inputTokens: 6, outputTokens: 1 }))
  o.live.set(RUN, { status: "idle", nodes: ["chat#2/ask"] })
  return row
}

/** A run whose log is one schema-8 line. */
function unreadable(o: Office): RunRow {
  const row = aRun(o)
  fs.writeFileSync(logFile(o, row.runId), line(0, "run_started", {}, { schema: 8n }))
  return row
}

async function bytesOf(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

test("a chats page has what its log and the store say", async () => {
  const o = office()
  const row = chat(o)
  o.store.recordUsage({ sessionId: row.sessionId, runId: RUN, model: "stub", usd: 0.25 })
  const detail = await runsFor(o).detail(RUN)
  expect([detail.log_state, detail.learnable, detail.repo_commit]).toEqual([
    "ok",
    true,
    o.store.getSession(row.sessionId)!.repo_commit,
  ])
  expect(detail.flow_fingerprint).toHaveLength(64)
  expect(detail.models?.["chat/reply"]).toBe("stub")
  expect(detail.usage).toEqual({ input_tokens: 6, output_tokens: 1, usd: 0.25 })
  expect([detail.run.status, detail.parent]).toEqual(["idle", null])
})

test("a run with no log says whether it started", async () => {
  const o = office()
  const ended = aRun(o)
  const stillOpen = aRun(o)
  o.store.endRun(ended.runId, COULDNT_START)
  const runs = runsFor(o)
  const got = await runs.detail(ended.runId)
  expect([got.log_state, got.log_message]).toEqual(["not_started", NOT_STARTED])
  expect(NOT_STARTED).toBe("no run log: the run didn't start")
  expect((await runs.detail(stillOpen.runId)).log_message).toBe(NOT_STARTED_YET)
  expect(NOT_STARTED_YET).toBe("not started yet")
  // A run yian knows whose log isn't there any more.
  o.index.set(stillOpen.runId, indexRow(stillOpen.runId))
  expect((await runs.detail(stillOpen.runId)).log_message).toBe(LOG_GONE)
})

test("a log this office cant read says so", async () => {
  const o = office()
  const got = await runsFor(o).detail(unreadable(o).runId)
  expect([got.log_state, got.log_message]).toEqual([
    "unsupported_schema",
    "This log uses run-log schema 8, which is older than this office supports",
  ])
})

test("reasons in the header parent and children are shown as stored", async () => {
  const o = office()
  const top = chat(o)
  const kid = aRun(o, { kind: "side" })
  o.index.set(kid.runId, indexRow(kid.runId, { flow: "shared/flows/side_chat.yaml", parentRunId: top.runId }))
  o.store.endRun(kid.runId, `401 for ${KEY}`) // stored as given
  const runs = runsFor(o)
  const head = await runs.detail(top.runId)
  const child = await runs.detail(kid.runId)
  expect(head.run.children![0]!.reason).toBe(`401 for ${KEY}`)
  expect([child.run.reason, child.parent?.run_id]).toEqual([`401 for ${KEY}`, top.runId])
})

test("the list never opens a log", async () => {
  const o = office()
  chat(o)
  const reader = new RunLogReader({
    refresh: () => {
      throw new Error("the list read a run log")
    },
  })
  const inspections = new Inspections(o.runsDir, (): RunInspection => {
    throw new Error("the list inspected a run log")
  })
  const runs = runsFor(o, { reader, inspections })
  expect(runs.page().runs[0]!.status).toBe("idle")
  expect(runs.runUpdated(RUN)!.data).toMatchObject({ status: "idle" })
})

test("the timeline is node attempts newest first with their kinds", async () => {
  const dir = tempDir()
  const o = office(path.join(dir, "runs"))
  const row = aRun(o)
  const { codeRoot } = await realRun(dir, LOOP_FLOW, {}, row.runId)
  const pinned: string[] = []
  const pin = async (commit: string) => {
    pinned.push(commit)
    return codeRoot
  }
  const page = await runsFor(o, { pin }).nodes(row.runId, { before: null, limit: 1000 })
  expect(pinned).toEqual([o.store.getSession(row.sessionId)!.repo_commit])
  const seqs = page.nodes.map((n) => n.seq)
  expect(seqs).toEqual([...seqs].sort((a, b) => b - a))
  expect(page.nodes.map((n) => [n.node_id, n.status, n.kind])).toEqual([
    ["__end__", "succeeded", "end"],
    ["l~2", "succeeded", "loop"],
    ["l#1/__end__", "succeeded", "end"],
    ["l#1/__start__", "succeeded", "start"],
    ["l~1", "expanded", "loop"],
    ["l#0/__end__", "succeeded", "end"],
    ["l#0/__start__", "succeeded", "start"],
    ["l", "expanded", "loop"],
    ["__start__", "succeeded", "start"],
  ])
  expect(page.nodes.every((n) => (n.end_seq ?? -1) > n.seq)).toBe(true)
  // Without a pinned worktree, or when pinning fails, kinds are unknown.
  const logged: string[] = []
  const failing = runsFor(o, {
    pin: () => Promise.reject(new RangeError(`no commit ${KEY}`)),
    log: (l) => logged.push(l),
  })
  const unknown = await failing.nodes(row.runId, { before: null, limit: 1000 })
  expect(new Set(unknown.nodes.map((n) => n.kind))).toEqual(new Set([null]))
  expect(logged).toEqual(["pin for a run page failed (RangeError)"])
  expect(new Set((await runsFor(o).nodes(row.runId, { before: null, limit: 3 })).nodes.map((n) => n.kind))).toEqual(
    new Set([null]),
  )
})

test("a run with no log has no records", async () => {
  const o = office()
  const row = aRun(o)
  o.store.endRun(row.runId, COULDNT_START)
  const runs = runsFor(o)
  await expect(runs.events(row.runId, { after: null, limit: 10 })).rejects.toBeInstanceOf(NoLog)
  await expect(runs.nodes(row.runId, { before: null, limit: 10 })).rejects.toBeInstanceOf(NoLog)
  await expect(runs.event(row.runId, 0)).rejects.toBeInstanceOf(NoLog)
  await expect(runs.log(row.runId)).rejects.toBeInstanceOf(NoLog)
  await expect(runs.events(newId(), { after: null, limit: 10 })).rejects.toBeInstanceOf(NotFound)
})

test("a log this office cant read has no nodes but still downloads", async () => {
  const o = office()
  const row = unreadable(o)
  const runs = runsFor(o)
  await expect(runs.nodes(row.runId, { before: null, limit: 10 })).rejects.toBeInstanceOf(UnsupportedSchema)
  expect(Object.getPrototypeOf(UnsupportedSchema.prototype)).toBe(UnreadableLog.prototype)
  expect((await bytesOf(await runs.log(row.runId))).includes("run_started")).toBe(true)
  expect(runs.page().runs.length).toBeGreaterThan(0) // the list is unaffected
})

test("records page and one record is whole", async () => {
  const o = office()
  chat(o)
  const runs = runsFor(o)
  const page = await runs.events(RUN, { after: null, limit: 500 })
  expect([page.events[0]!.seq, page.events[0]!.kind]).toEqual([0, "run_started"])
  const done = page.events.find((e) => e.kind === "node_succeeded" && (e.node_id ?? "").endsWith("/reply"))!
  expect(done.payload).toMatchObject({ node_id: done.node_id })
  expect(await runs.event(RUN, done.seq)).toEqual(done)
  await expect(runs.event(RUN, 10_000)).rejects.toThrow(new NotFound(`run ${RUN} has no record 10000`))
})

test("a connection key a reply echoes is shown as stored", async () => {
  const o = office()
  const row = aRun(o, { runId: RUN })
  const file = logFile(o, RUN)
  fs.writeFileSync(
    file,
    Buffer.concat([
      runStarted(0),
      started(1, "chat#0/reply"),
      committed(2, "chat#0/reply", { output: `the key is ${KEY}` }),
      succeeded(3, "chat#0/reply", 2),
    ]),
  )
  const runs = runsFor(o)
  const page = await runs.events(row.runId, { after: null, limit: 500 })
  const reply = page.events.find((e) => e.kind === "pool_commit")!
  expect(JSON.stringify(reply)).toContain(`the key is ${KEY}`)
  expect(JSON.stringify(await runs.event(RUN, reply.seq))).toContain(`the key is ${KEY}`)
  expect((await bytesOf(await runs.log(RUN))).equals(fs.readFileSync(runs.logPath(RUN)))).toBe(true)
})

test("a header then its timeline read the log whole once", async () => {
  const o = office()
  chat(o)
  const starts: number[] = []
  const reader = new RunLogReader({
    refresh: (file, index, options) => {
      starts.push(index?.offset ?? 0)
      return refresh(file, index, options)
    },
  })
  const runs = runsFor(o, { reader })
  expect((await runs.detail(RUN)).log_state).toBe("ok")
  expect((await runs.nodes(RUN, { before: null, limit: 1000 })).nodes.length).toBeGreaterThan(0)
  expect((await runs.events(RUN, { after: null, limit: 10 })).events.length).toBeGreaterThan(0)
  expect(starts.filter((at) => at === 0)).toHaveLength(1)
})

test("run updated is built from the runs summary", async () => {
  const o = office()
  const parent = aRun(o)
  const row = aRun(o, { kind: "side" })
  o.index.set(row.runId, indexRow(row.runId, { parentRunId: parent.runId }))
  o.live.set(row.runId, { status: "running", nodes: ["side_chat#0/reply"] })
  const event = runsFor(o).runUpdated(row.runId)!
  expect([event.type, event.subject_id]).toEqual(["run.updated", row.runId])
  expect(event.data).toEqual({
    run_id: row.runId,
    session_id: row.sessionId,
    parent_run_id: parent.runId,
    status: "running",
    current_nodes: ["side_chat#0/reply"],
  })
  expect(runsFor(o).runUpdated(newId())).toBeNull()
})

/** The run routes over a real socket: GET /runs and one run's routes (store rows and a fake run index stand in for
 *  the chat harness), the office's run.updated, and GET /runs/{id}/live. */
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { RunLiveRecord } from "@opencorp/protocol"
import { expect, type Mock, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import type { RunIndexRow } from "@ngocbh/yian/run"
import { newToken } from "../../src/auth/tokens.ts"
import type { LiveJoin, LiveRelay, LiveWorker } from "../../src/daemon/live.ts"
import type { Office } from "../../src/daemon/office.ts"
import { HUGE_LINE, readEvents, refresh, RunLogReader, SCHEMA } from "../../src/runs/reader.ts"
import { Live, type LiveRun } from "../../src/runs/records.ts"
import { WORKER_STOPPED } from "../../src/runs/outcomes.ts"
import { RunLogs } from "../../src/runs/service.ts"
import { newId } from "../../src/store/store.ts"
import type { ScriptedReply } from "../../src/testing/fake_llm.ts"
import type { Frame as WorkerFrame } from "../../src/worker/channel.ts"
import { fakeLlm, send, TemplateOffice, waitingChat } from "../chat/helpers.ts"
import { tempDir, waitFor } from "../helpers.ts"
import { chatLog, committed, failed, fifoAt, line, runStarted, started, succeeded } from "../runs/helpers.ts"
import { session } from "../store/helpers.ts"
import { advanceJob, run } from "../worker/helpers.ts"
import {
  CEO,
  Conn,
  type Frame,
  ULID,
  bearer,
  checkedLive,
  frames,
  giveDevice,
  joinedRun,
  liveRelay,
  makeOffice,
  type Reply,
  repliesOf,
  request,
  served,
  socketCapacity,
  standInHarness,
  storedRun,
  stubWorker,
  take,
  waitsForClient,
  within,
} from "./helpers.ts"

setDefaultTimeout(30_000)

const T = "2026-10-20T10:00:00.000Z"
const KEY = "conn-key-5f3a9c1e7b2d4a60"
const NOBODY = "01K0000000000000000000000Z"

/** A served office whose Run Logs read `index` as yian's run index and `live` as the actor's memory. */
async function servedRuns(): Promise<{
  office: Office
  sock: string
  index: Map<string, RunIndexRow>
  live: Map<string, LiveRun>
}> {
  const office = makeOffice()
  const index = new Map<string, RunIndexRow>()
  const live = new Map<string, LiveRun>()
  office.runs = new RunLogs({
    store: office.store,
    runsDir: office.paths.runs,
    index: () => index,
    live: () => new Live(new Map(live)),
  })
  const { sock } = await served(office)
  return { office, sock, index, live }
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

/** A run row of a new ended session, launched `at`; with `parent`, a run yian's index links to it (cancelled, so
 *  interrupted). */
function aRun(
  office: Office,
  index: Map<string, RunIndexRow>,
  { flow = "chat", driver = "ngocbh", parent, at = T }: { flow?: string; driver?: string; parent?: string; at?: string } =
    {},
): string {
  const s = office.store.createSession(session({ status: "ended" }))
  const runId = newId()
  office.store.addRun({
    runId,
    sessionId: s.id,
    driver,
    flow,
    flowPath: `shared/flows/${flow}.yaml`,
    connection: null,
    model: null,
    configSha256: null,
    replacesRunId: null,
    createdAt: at,
  })
  if (parent !== undefined) {
    index.set(runId, indexRow(runId, { flow: `shared/flows/${flow}.yaml`, parentRunId: parent, status: "cancelled" }))
  }
  return runId
}

function get(sock: string, target: string, params: Record<string, string> = {}): Promise<Reply> {
  const query = new URLSearchParams(params).toString()
  return request(sock, "GET", query ? `${target}?${query}` : target)
}

function body(r: Reply): Record<string, unknown> {
  return r.json() as Record<string, unknown>
}

function ids(r: Reply): string[] {
  return (body(r).runs as { run_id: string }[]).map((x) => x.run_id)
}

test("get runs lists top level runs and one runs children", async () => {
  const { office, sock, index } = await servedRuns()
  const top = aRun(office, index)
  const kid = aRun(office, index, { flow: "side_chat", parent: top })
  const r = await get(sock, "/runs")
  expect([r.status, ids(r), body(r).next]).toEqual([200, [top], null])
  const [run] = body(r).runs as { children: unknown[]; children_total: number }[]
  expect([run!.children, run!.children_total]).toEqual([[], 1])
  const kids = await get(sock, "/runs", { parent: top })
  expect([kids.status, ids(kids), body(kids).next]).toEqual([200, [kid], null])
  const missing = await get(sock, "/runs", { parent: newId() })
  expect([missing.status, body(missing).error]).toEqual([404, "not_found"])
})

test("get runs filters by statuses and a launch range and pages", async () => {
  const { office, sock, index } = await servedRuns()
  const old = aRun(office, index, { at: "2026-10-01T10:00:00.000Z" })
  const failedRuns = [0, 1, 2].map(() => aRun(office, index))
  for (const runId of [old, ...failedRuns]) office.store.endRun(runId, WORKER_STOPPED)
  const done = aRun(office, index)
  index.set(done, indexRow(done))
  aRun(office, index, { at: "2026-10-22T10:00:00.000Z" })
  const query = { status: "failed,finished", since: "2026-10-13T10:00:00Z", until: "2026-10-21T00:00:00+00:00" }
  const one = await get(sock, "/runs", { ...query, limit: "2" })
  expect([ids(one), body(one).next]).toEqual([[done, failedRuns[2]], failedRuns[2]])
  const two = await get(sock, "/runs", { ...query, limit: "2", before: body(one).next as string })
  expect([ids(two), body(two).next]).toEqual([[failedRuns[1], failedRuns[0]], null])
  expect(ids(await get(sock, "/runs", { ...query, q: failedRuns[0]!.slice(-6).toLowerCase() }))).toEqual([
    failedRuns[0],
  ])
  const kid = aRun(office, index, { flow: "side_chat", parent: done, driver: "lan" })
  for (const params of [{ person: "lan" }, { person: "lan", ...query }])
    expect(ids(await get(sock, "/runs", params))).toEqual([done])
  expect(ids(await get(sock, "/runs", { parent: done, ...query }))).toEqual([])
  expect(ids(await get(sock, "/runs", { parent: done, status: "running,interrupted" }))).toEqual([kid])
})

test("a failure reaches get runs as stored", async () => {
  const { office, sock, index } = await servedRuns()
  const runId = aRun(office, index)
  office.store.endRun(runId, "AuthError: Bearer abcdefgh12345")
  const r = await get(sock, "/runs")
  expect(r.status).toBe(200)
  expect((body(r).runs as { reason: string }[])[0]!.reason).toBe("AuthError: Bearer abcdefgh12345")
})

const BAD_LISTS: Record<string, string>[] = [
  { status: "busy" },
  { status: "failed," },
  { status: "failed,busy" },
  { limit: "0" },
  { limit: "201" },
  { limit: "x" },
  { limit: "+5" },
  { limit: " 5" },
  { limit: "1_0" },
  { limit: "9".repeat(5000) },
  { since: "yesterday" },
  { until: "2026-10-20T10:00:00" },
  { since: "2026-13-01T00:00:00Z" },
  { parent: NOBODY, status: "busy" },
  { parent: NOBODY, limit: "0" },
]

test.each(BAD_LISTS.map((params) => [JSON.stringify(params).slice(0, 60), params] as const))(
  "get runs refuses a bad status limit or time [%s]",
  async (_, params) => {
    const { sock } = await servedRuns()
    const r = await get(sock, "/runs", params)
    expect([r.status, body(r).error]).toEqual([422, "invalid_body"])
  },
)

test("a parent with more children than sqlite binds at once lists", async () => {
  const { office, sock, index } = await servedRuns()
  const top = aRun(office, index)
  const side = office.store.createSession(session({ kind: "side", status: "ended" }))
  const kids = Array.from({ length: 33_000 }, () => newId())
  office.store.transaction((tx) => {
    for (const runId of kids)
      tx.insert("runs", {
        run_id: runId,
        session_id: side.id,
        flow: "side_chat",
        flow_path: "shared/flows/side_chat.yaml",
        driver: "lan",
        created_at: T,
      })
  })
  for (const kid of kids) {
    index.set(kid, indexRow(kid, { flow: "shared/flows/side_chat.yaml", parentRunId: top, status: "cancelled" }))
  }
  let r = await get(sock, "/runs", { person: "lan", since: "2026-10-13T10:00:00.000Z" })
  expect([r.status, ids(r)]).toEqual([200, [top]])
  expect((body(r).runs as { children_total: number }[])[0]!.children_total).toBe(33_000)
  r = await get(sock, "/runs", { parent: top, status: "interrupted", limit: "200" })
  expect([r.status, ids(r).length]).toEqual([200, 200])
}, 30_000)

test("get runs recent is open runs of any age and runs started since", async () => {
  const { office, sock, index, live } = await servedRuns()
  const s = office.store.createSession(session({ status: "idle" }))
  const oldOpen = newId()
  office.store.addSessionRun(s.id, oldOpen)
  office.store.addRun({
    runId: oldOpen,
    sessionId: s.id,
    driver: "ngocbh",
    flow: "chat",
    flowPath: "shared/flows/chat.yaml",
    connection: null,
    model: null,
    configSha256: null,
    replacesRunId: null,
    createdAt: "2026-09-01T10:00:00.000Z",
  })
  live.set(oldOpen, { status: "idle", nodes: [] })
  const oldClosed = aRun(office, index, { at: "2026-09-01T10:00:00.000Z" })
  index.set(oldClosed, indexRow(oldClosed))
  const recent = aRun(office, index)
  office.store.endRun(recent, WORKER_STOPPED)
  let r = await get(sock, "/runs", { recent: "2026-10-13T10:00:00Z", limit: "50" })
  expect([r.status, ids(r)]).toEqual([200, [recent, oldOpen]])
  r = await get(sock, "/runs", { recent: "2026-10-13T10:00:00Z", status: "failed" })
  expect(ids(r)).toEqual([recent])
  const kid = aRun(office, index, { flow: "side_chat", parent: oldClosed, at: "2026-10-15T10:00:00.000Z" })
  r = await get(sock, "/runs", { parent: oldClosed, recent: "2026-10-13T10:00:00Z" })
  expect(ids(r)).toEqual([kid])
})

const BAD_RECENT: Record<string, string>[] = [
  { recent: "2026-10-13T10:00:00Z", since: "2026-10-13T10:00:00Z" },
  { recent: "2026-10-13T10:00:00Z", until: "2026-10-13T10:00:00Z" },
  { recent: "last week" },
  { recent: "2026-10-13T10:00:00" },
  { parent: NOBODY, recent: "2026-10-13T10:00:00Z", since: "2026-10-13T10:00:00Z" },
]

test.each(BAD_RECENT.map((params) => [JSON.stringify(params), params] as const))(
  "get runs refuses a bad recent or recent with a range [%s]",
  async (_, params) => {
    const { sock } = await servedRuns()
    const r = await get(sock, "/runs", params)
    expect([r.status, body(r).error]).toEqual([422, "invalid_body"])
  },
)

/** A served office with its own Run Logs; its log (a run with no outcome is told) is dropped. */
async function servedQuietly(): Promise<{ office: Office; sock: string }> {
  const office = makeOffice({ log: () => {} })
  const { sock } = await served(office)
  return { office, sock }
}

/** A run of a new ended session at the company's head, its log (under the office's own Run Logs) a synthetic chat
 *  log of two turns, one line in `schema`, the bytes `log`, or none. */
async function withLog(
  office: Office,
  { schema = BigInt(SCHEMA), log = true }: { schema?: bigint; log?: Buffer | boolean } = {},
): Promise<string> {
  const s = office.store.createSession(session({ status: "ended", repo_commit: await office.git.head() }))
  const runId = newId()
  office.store.addRun({
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
  })
  if (log !== false) {
    const file = office.runs.logPath(runId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (Buffer.isBuffer(log)) fs.writeFileSync(file, log)
    else if (schema === BigInt(SCHEMA)) chatLog(file)
    else fs.writeFileSync(file, line(0, "run_started", {}, { schema }))
  }
  return runId
}

test("one runs routes", async () => {
  const { office, sock } = await servedQuietly()
  const runId = await withLog(office)
  expect(body(await get(sock, `/runs/${runId}`)).log_state).toBe("ok")
  const nodes = body(await get(sock, `/runs/${runId}/nodes`, { limit: "2" })) as {
    nodes: { node_id: string; kind: string | null }[]
    next_before: number | null
  }
  expect([nodes.nodes.map((n) => n.node_id), nodes.next_before]).toEqual([["chat#2/ask", "chat#1/reply"], 16])
  expect(new Set(nodes.nodes.map((n) => n.kind))).toEqual(new Set([null]))
  const events = body(await get(sock, `/runs/${runId}/events`, { after: "16" })) as {
    events: { seq: number }[]
    next_after: number | null
  }
  expect([events.events.map((e) => e.seq), events.next_after]).toEqual([[17, 18, 19], null])
  expect(body(await get(sock, `/runs/${runId}/events/3`)).kind).toBe("node_started")
  const log = await get(sock, `/runs/${runId}/log`)
  expect(log.status).toBe(200)
  expect(log.headers["content-type"]).toBe("application/x-ndjson")
  expect(log.headers["content-disposition"]).toBe(`attachment; filename="${runId}.jsonl"`)
  expect(log.headers["cache-control"]).toBe("no-store")
  expect(log.text).toBe(fs.readFileSync(office.runs.logPath(runId), "utf8")) // as stored
  expect(log.text.split("\n").filter(Boolean)).toHaveLength(20)
})

test("one runs routes say what went wrong", async () => {
  const { office, sock } = await servedQuietly()
  const runId = await withLog(office)
  expect((await get(sock, `/runs/${newId()}`)).status).toBe(404)
  expect(body(await get(sock, `/runs/${runId}/events/99`)).error).toBe("not_found")
  expect((await get(sock, `/runs/${runId}/events`, { limit: "501" })).status).toBe(422)
  const old = await withLog(office, { schema: 8n })
  const r = await get(sock, `/runs/${old}/nodes`)
  expect([r.status, body(r).error]).toEqual([409, "unsupported_schema"])
  expect((await get(sock, `/runs/${old}/log`)).status).toBe(200) // the download doesn't need the schema
  const none = await withLog(office, { log: false })
  const gone = await get(sock, `/runs/${none}/events`)
  expect([gone.status, body(gone).error]).toEqual([404, "no_log"])
})

test.each([
  ["/events", { after: "1000000000" }, 200],
  ["/events/1000000000", {}, 404],
  ["/nodes", { before: "1000000000" }, 200],
  ["/events", { after: "9007199254740991" }, 200],
] as const)("a seq of ten digits or more up to the safe integers is read [%s %o]", async (suffix, params, status) => {
  const { office, sock } = await servedQuietly()
  const runId = await withLog(office)
  const r = await get(sock, `/runs/${runId}${suffix}`, params)
  expect(r.status).toBe(status)
  if (status === 404) expect(body(r).error).toBe("not_found")
})

test("a limit with leading zeros is read", async () => {
  const { sock } = await servedRuns()
  expect((await get(sock, "/runs", { limit: "0000000001" })).status).toBe(200)
})

test("a seq past the safe integers is refused with the real bound and not echoed", async () => {
  const { office, sock } = await servedQuietly()
  const runId = await withLog(office)
  for (const target of [`/runs/${runId}/events?after=9007199254740992`, `/runs/${runId}/events/9007199254740992`]) {
    const r = await request(sock, "GET", target)
    const name = target.includes("after") ? "after" : "seq"
    expect([r.status, r.json()]).toEqual([
      422,
      { error: "invalid_body", message: `${name} must be an integer from 0 to 9007199254740991` },
    ])
    expect(r.text).not.toContain("9007199254740992")
  }
})

test("the download has no head so a head never opens the log", async () => {
  const { office, sock } = await servedQuietly()
  const runId = await withLog(office)
  let opened = 0
  const open = office.runs.log.bind(office.runs)
  office.runs.log = (id) => {
    opened += 1
    return open(id)
  }
  const head = await request(sock, "HEAD", `/runs/${runId}/log`)
  expect([head.status, head.headers.allow, head.text, opened]).toEqual([405, "GET", "", 0])
})

test("one huge record is a size stub", async () => {
  const { office, sock } = await servedQuietly()
  const big = committed(2, "a", { output: "b".repeat(HUGE_LINE) })
  const runId = await withLog(office, { log: Buffer.concat([runStarted(0), started(1, "a"), big]) })
  const r = await get(sock, `/runs/${runId}/events/2`)
  expect(r.status).toBe(200)
  const got = body(r)
  expect([got.kind, got.node_id, got.payload, got.size]).toEqual(["pool_commit", "a", null, big.length])
}, 30_000)

test("a node error is shown as stored cut to 200", async () => {
  const { office, sock } = await servedQuietly()
  const log = Buffer.concat([runStarted(0), started(1, "a"), failed(2, "a", "x".repeat(186) + KEY)])
  const runId = await withLog(office, { log })
  const r = await get(sock, `/runs/${runId}/nodes`)
  expect((body(r).nodes as { error: string }[])[0]!.error).toBe(("x".repeat(186) + KEY).slice(0, 199) + "…")
})

test("a log removed before it streams has no log", async () => {
  const { office, sock } = await servedQuietly()
  const runId = await withLog(office)
  const file = office.runs.logPath(runId)
  const stored = fs.readFileSync(file, "utf8")
  const open = office.runs.log.bind(office.runs)
  office.runs.log = async (id) => {
    const stream = await open(id)
    fs.rmSync(file) // after the lookup opened it
    return stream
  }
  const whole = await get(sock, `/runs/${runId}/log`)
  expect([whole.status, whole.text]).toEqual([200, stored])
  const r = await get(sock, `/runs/${runId}/log`)
  expect([r.status, body(r).error]).toEqual([404, "no_log"])
})

const OUTSIDE = "OUTSIDE-SECRET-7d41c9a2"

/** A chat log outside the office's runs folder whose commit holds OUTSIDE; returns its path. */
function outsideLog(): string {
  const file = path.join(tempDir(), "outside.jsonl")
  fs.writeFileSync(file, Buffer.concat([runStarted(0), started(1, "a"), committed(2, "a", { output: OUTSIDE })]))
  return file
}

/** The status, error and whether OUTSIDE shows of GET `target`, and whether it answered within a second. */
async function refused(sock: string, target: string): Promise<[string, number, unknown, boolean, boolean]> {
  const start = performance.now()
  const r = await get(sock, target)
  const error = r.headers["content-type"]?.startsWith("application/json") ? body(r).error : null
  return [target, r.status, error, r.text.includes(OUTSIDE), performance.now() - start < 1000]
}

const LOG_ROUTES = ["/nodes", "/events", "/events/1", "/log", "/live"]

test("a log that is a symlink is no log on every route that reads it", async () => {
  const { office, sock } = await servedQuietly()
  const runId = await withLog(office)
  const file = office.runs.logPath(runId)
  fs.rmSync(file)
  fs.symlinkSync(outsideLog(), file)
  for (const suffix of LOG_ROUTES) {
    const target = `/runs/${runId}${suffix}`
    expect(await refused(sock, target)).toEqual([target, 404, "no_log", false, true])
  }
  const head = await get(sock, `/runs/${runId}`)
  expect([head.status, body(head).log_state, head.text.includes(OUTSIDE)]).toEqual([200, "missing", false])
})

test("a log swapped for a symlink after its index was built is no log", async () => {
  const { office, sock } = await servedQuietly()
  const runId = await withLog(office)
  const file = office.runs.logPath(runId)
  const outside = outsideLog()
  // The swap lands between the index's build and the page's read of the log, which `#logIndex` doesn't cover.
  const reader = new RunLogReader({
    refresh: async (log, index, options) => {
      const built = await refresh(log, index, options)
      fs.rmSync(file, { force: true })
      fs.symlinkSync(outside, file)
      return built
    },
  })
  office.runs = new RunLogs({ store: office.store, runsDir: office.paths.runs, reader })
  for (const suffix of ["/events", "/events/1"]) {
    const target = `/runs/${runId}${suffix}`
    expect(await refused(sock, target)).toEqual([target, 404, "no_log", false, true])
    fs.rmSync(file)
    chatLog(file)
  }
})

test("a log that is a fifo is no log at once on every route that reads it", async () => {
  const { office, sock } = await servedQuietly()
  const runId = await withLog(office)
  const file = office.runs.logPath(runId)
  fs.rmSync(file)
  fifoAt(file)
  // Not GET /runs/{id}: yian's inspection of a run still opens its log itself.
  for (const suffix of LOG_ROUTES) {
    const target = `/runs/${runId}${suffix}`
    expect(await refused(sock, target)).toEqual([target, 404, "no_log", false, true])
  }
})

test("a schema that isnt a number isnt echoed", async () => {
  const { office, sock } = await servedQuietly()
  const log = Buffer.from(`{"kind":"run_started","payload":{},"schema":"${KEY}","seq":0}\n`)
  const runId = await withLog(office, { log })
  const head = await get(sock, `/runs/${runId}`)
  const nodes = await get(sock, `/runs/${runId}/nodes`)
  expect([nodes.status, body(nodes).error]).toEqual([409, "unsupported_schema"])
  expect(head.text + nodes.text).not.toContain(KEY)
  expect(body(head).log_message).toBe("This log uses a run-log schema this office can't read")
})

test("run changed publishes run updated at once and coalesces the next one", async () => {
  const office = makeOffice()
  const s = office.store.createSession(session())
  const runId = newId()
  office.store.addSessionRun(s.id, runId)
  office.store.addRun({
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
  })
  office.harness = standInHarness({
    live: () => new Live(new Map([[runId, { status: "running", nodes: ["chat#0/reply"] }]])),
  })
  const sub = office.bus.subscribe(null, { types: ["run.updated"] })
  office.runChanged(runId)
  office.runChanged(runId) // within a second: coalesced, sent by the timer
  expect(sub.queued).toBe(1)
  const got = await sub.next(1000)
  expect(got).not.toBeNull()
  const [, event] = got as readonly ["meta", { subject_id: string; data: unknown }]
  expect([event.subject_id, event.data]).toEqual([
    runId,
    { run_id: runId, session_id: s.id, parent_run_id: null, status: "running", current_nodes: ["chat#0/reply"] },
  ])
  const next = await sub.next(2000)
  expect(next).not.toBeNull()
  expect((next as readonly ["meta", { type: string; subject_id: string }])[1]).toMatchObject({
    type: "run.updated",
    subject_id: runId,
  })
})

/** Opens `target` with a `node:http` request; resolves with the response. The request is destroyed when the test
 *  finishes. */
function open(sock: string, target: string, headers: Record<string, string> = {}): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, path: target, headers, agent: false }, (res) => {
      // The cleanup's destroy cuts an unfinished response, which then errors with nobody reading it.
      res.on("error", () => {})
      resolve(res)
    })
    onTestFinished(() => req.destroy())
    req.on("error", reject)
    req.end()
  })
}

/** Every frame of `res` until the stream ends, within 5 s. */
async function all(res: http.IncomingMessage): Promise<Frame[]> {
  return within(Array.fromAsync(frames(res)))
}

/** The record frame of each record of the log `log`, by seq, as its run page shows it. */
async function recordFrames(log: string): Promise<Frame[]> {
  const page = readEvents(log, await refresh(log, null), { after: null, limit: 10_000 })
  expect(page.next_after).toBeNull()
  return page.events.map((event): Frame => {
    return ["record", null, JSON.parse(JSON.stringify({ seq: event.seq, record: event }))]
  })
}

/** The next `n` frames of `it`, each checked as a live frame. */
async function read(it: AsyncIterator<Frame>, n: number): Promise<Frame[]> {
  return checkedLive(await take(it, n))
}

/** Every frame left in `it` until the stream ends, within 5 s, each checked as a live frame. */
async function rest(it: AsyncIterator<Frame>): Promise<Frame[]> {
  const got: Frame[] = []
  await within(
    (async () => {
      for (let step = await it.next(); !step.done; step = await it.next()) got.push(step.value)
    })(),
  )
  return checkedLive(got)
}

/** A stored run with a finished chat turn answering with `replies`, recorded at its log path: its id, log, the live
 *  frames its worker sent, a stand-in worker of it and the relay on `office.live`, which has been fed nothing. */
async function recordedRun(
  office: Office,
  replies: ScriptedReply[],
): Promise<{ runId: string; log: string; fed: WorkerFrame[]; worker: LiveWorker; relay: LiveRelay }> {
  const { runId, sessionId, log } = storedRun(office, { turns: null })
  const fake = await fakeLlm()
  fake.script(...replies)
  const job = await waitingChat(fake, "chat", {}, { runId, runs: office.paths.runs })
  expect(job.log).toBe(log)
  const rec = await run(advanceJob(job, { deliver: [send("s1", "hi")] }), new TemplateOffice(), { env: fake.env() })
  expect(rec.streams[0]?.type).toBe("snapshot")
  return { runId, log, fed: rec.streams, worker: stubWorker(runId, sessionId, log), relay: liveRelay(office) }
}

/** The step key of a call or chunk: `node:n`. */
function stepKey(data: unknown): string {
  const { node, n } = data as { node: string; n: number }
  return `${node}:${n}`
}

/** The frames a stream of the log `log` sends after `after` with no worker: connected, a record per page event, then
 *  run_end. */
async function expected(log: string, after: number | null): Promise<Frame[]> {
  const records = (await recordFrames(log)).filter(([, , data]) => (data as { seq: number }).seq > (after ?? -1))
  return [["comment", null, "connected"], ...records, ["run_end", null, {}]]
}

test("the live route answers 404 for a run the store does not hold", async () => {
  // A row whose session is gone can't be set up: runs.session_id references sessions with ON DELETE CASCADE.
  const office = makeOffice()
  const { sock } = await served(office)
  const r = await request(sock, "GET", `/runs/${ULID}/live`)
  expect(r.status).toBe(404)
  expect(r.headers["content-type"]).toStartWith("application/json")
  expect(r.json()).toEqual({ error: "not_found", message: `no run ${ULID}` })
})

test("the live route answers 404 no log for a run without a log", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId } = storedRun(office, { turns: null })
  const r = await request(sock, "GET", `/runs/${runId}/live`)
  expect(r.status).toBe(404)
  expect(r.json()).toEqual({
    error: "no_log",
    message: "this run has no log: it didn't start, or its log is gone",
  })
})

test("the live route refuses an after that is not a seq without echoing it", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId } = storedRun(office)
  for (const value of ["-1", "1.5", "x", "99999999999999999999"]) {
    const r = await request(sock, "GET", `/runs/${runId}/live?after=${value}`)
    expect([r.status, value]).toEqual([422, value])
    expect(r.json()).toEqual({ error: "invalid_body", message: "after must be a record seq from 0" })
    expect(r.text).not.toContain(value)
  }
})

test("the live route refuses head", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId } = storedRun(office)
  const r = await request(sock, "HEAD", `/runs/${runId}/live`)
  expect(r.status).toBe(405)
  expect(r.headers.allow).toBe("GET")
})

test("a run no worker feeds streams its log then run end", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  // Over 64 records, so the stream yields to the event loop between batches.
  const { runId, log } = storedRun(office, { turns: 10 })
  const res = await open(sock, `/runs/${runId}/live`)
  expect(res.statusCode).toBe(200)
  expect(res.headers["content-type"]).toBe("text/event-stream; charset=utf-8")
  expect(res.headers["cache-control"]).toBe("no-cache")
  const got = await all(res)
  const want = await expected(log, null)
  expect(want.length).toBe(86)
  expect(got).toEqual(want)
  for (const [event, , data] of got) if (event === "record") RunLiveRecord.parse(data)
})

test("the live route skips records up to after", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId, log } = storedRun(office)
  for (const after of [0, 5, 18]) {
    const got = await all(await open(sock, `/runs/${runId}/live?after=1&after=${after}`))
    expect(got).toEqual(await expected(log, after))
    expect((got[1]![2] as { seq: number }).seq).toBe(after + 1)
  }
  const past = await all(await open(sock, `/runs/${runId}/live?after=19`))
  expect(past).toEqual([
    ["comment", null, "connected"],
    ["run_end", null, {}],
  ])
})

test("a reconnect reads the log from the run index", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId, log } = storedRun(office, { turns: 10 })
  const want = await expected(log, 70)
  // Built as the run page would have, so the stream's own reads are only its index refresh and its records.
  const index = (await office.runs.logIndex(log))!
  expect(index.sparse.map(([seq]) => seq)).toEqual([0, 64])
  const logIndex = spyOn(office.runs, "logIndex")
  const read = spyOn(fs, "readSync")
  onTestFinished(() => read.mockRestore())
  expect(await all(await open(sock, `/runs/${runId}/live?after=70`))).toEqual(want)
  // Asked again at the end, so the index read covers the whole log.
  expect(logIndex.mock.calls).toEqual([[log], [log]])
  // The records are read from the sparse entry of seq 64, and nothing is read from byte 0.
  const positions = read.mock.calls.map((call) => (call as unknown[])[4])
  expect([positions.includes(index.sparse[1]![1]), positions.includes(0)]).toEqual([true, false])
  read.mockRestore()
  // A stream from the start checks the log against the run index too.
  expect(await all(await open(sock, `/runs/${runId}/live`))).toEqual(await expected(log, null))
  expect(logIndex).toHaveBeenCalledTimes(4)
})

/** A line the run pages refuse after `storedRun`'s last seq (19), by name. */
const REFUSED_LINES: [string, Buffer][] = [
  ["an unknown kind", line(20, "wat_kind", {})],
  ["another schema", line(20, "node_started", { node_id: "a" }, { schema: 99n })],
]

test.each(REFUSED_LINES)("a log line the pages refuse resets a stream with no worker [%s]", async (_, bad) => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId, log } = storedRun(office)
  fs.appendFileSync(log, bad)
  expect(await all(await open(sock, `/runs/${runId}/live`))).toEqual([
    ["comment", null, "connected"],
    ["reset", null, null],
  ])
  const page = await request(sock, "GET", `/runs/${runId}/events`)
  expect([page.status, body(page).error]).toEqual([409, "unsupported_schema"])
})

test.each(REFUSED_LINES)("a log line the pages refuse resets a stream at its run end [%s]", async (_, bad) => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId, log, lastSeq, relay, worker } = joinedRun(office)
  const records = await recordFrames(log)
  const it = frames(await open(sock, `/runs/${runId}/live`))
  expect(await read(it, 2 + lastSeq)).toEqual([["comment", null, "connected"], ...records])
  fs.appendFileSync(log, bad)
  relay.detach(worker)
  expect(await rest(it)).toEqual([["reset", null, null]])
})

/** Appends a commit and a success to `storedRun`'s log (last seq 19): seqs 20 and 21. */
function appendTwo(log: string): void {
  fs.appendFileSync(log, committed(20, "chat#2/ask", { output: "hi" }))
  fs.appendFileSync(log, succeeded(21, "chat#2/ask", 20))
}

test("a record appended between the index build and the join doesn't reset", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId, sessionId, log } = storedRun(office)
  const stale = (await office.runs.logIndex(log))!
  expect(stale.lastSeq).toBe(19)
  appendTwo(log)
  const relay = liveRelay(office)
  const worker = stubWorker(runId, sessionId, log)
  relay.frame(worker, { type: "snapshot", snapshot: { last_seq: 21, calls: [] } })
  // The stream's first index is the build from before the append, as a build still in flight at the join would be.
  spyOn(office.runs, "logIndex").mockImplementationOnce(async () => stale)
  const records = await recordFrames(log)
  expect(records).toHaveLength(22)
  const it = frames(await open(sock, `/runs/${runId}/live`))
  expect(await read(it, 1 + records.length)).toEqual([["comment", null, "connected"], ...records])
  relay.detach(worker)
  expect(await rest(it)).toEqual([["run_end", null, {}]])
})

test("run end with a stale build in flight still sends every record", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId, sessionId, log } = storedRun(office)
  const relay = liveRelay(office)
  const worker = stubWorker(runId, sessionId, log)
  const from = 15
  relay.frame(worker, { type: "snapshot", snapshot: { last_seq: from, calls: [] } })
  const it = frames(await open(sock, `/runs/${runId}/live`))
  const head = await read(it, 2 + from)
  const stale = (await office.runs.logIndex(log))!
  expect(stale.lastSeq).toBe(19)
  appendTwo(log)
  spyOn(office.runs, "logIndex").mockImplementationOnce(async () => ({ ...stale }))
  relay.detach(worker)
  const records = await recordFrames(log)
  expect([...head, ...(await rest(it))]).toEqual([["comment", null, "connected"], ...records, ["run_end", null, {}]])
})

test("a stream waiting on its index sends pings", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { pingMs: 50 })
  const { runId, log } = storedRun(office)
  const logIndex = office.runs.logIndex.bind(office.runs)
  spyOn(office.runs, "logIndex").mockImplementationOnce(async (file) => {
    await Bun.sleep(250)
    return logIndex(file)
  })
  const got = await all(await open(sock, `/runs/${runId}/live`))
  const first = got.findIndex(([event]) => event === "record")
  const pings = got.slice(0, first).filter(([event, , data]) => event === "comment" && data === "ping")
  expect(pings.length).toBeGreaterThanOrEqual(2)
  expect(got.filter(([event]) => event !== "comment")).toEqual([...(await recordFrames(log)), ["run_end", null, {}]])
})

test("a log swapped for a symlink before the stream reads it gets reset", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId, log } = joinedRun(office)
  const outside = outsideLog()
  const logIndex = office.runs.logIndex.bind(office.runs)
  spyOn(office.runs, "logIndex").mockImplementationOnce(async (file) => {
    const index = await logIndex(file)
    fs.rmSync(log)
    fs.symlinkSync(outside, log)
    return index
  })
  const res = await open(sock, `/runs/${runId}/live`)
  const got = await all(res)
  expect(got).toEqual([
    ["comment", null, "connected"],
    ["reset", null, null],
  ])
  expect(JSON.stringify(got)).not.toContain(OUTSIDE)
})

test("a live stream sends the log to the joins seq then the calls then frames", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId, log, fed, worker, relay } = await recordedRun(office, [
    { content: "Let me check that", tool_calls: [{ id: "c1", name: "toolbox_stub" }] },
    { content: "All done now friend" },
  ])
  const full = new Map<string, string>()
  for (const frame of fed) {
    if (frame.type === "chunk") full.set(stepKey(frame), (full.get(stepKey(frame)) ?? "") + frame.text)
  }
  expect([...full.values()]).toEqual(["Let me check that", "All done now friend"])
  // Joined mid call, after the first call's second chunk.
  const at = fed.findIndex((frame) => frame.type === "chunk" && frame.index === 1) + 1
  for (const frame of fed.slice(0, at)) relay.frame(worker, frame)
  const peek = relay.join(runId) as LiveJoin
  peek.viewer.close()
  expect(peek.calls.some((call) => call.text !== "")).toBe(true)
  const records = await recordFrames(log)
  const it = frames(await open(sock, `/runs/${runId}/live`))
  const head = await read(it, 2 + peek.lastSeq + peek.calls.length)
  expect(head).toEqual([
    ["comment", null, "connected"],
    ...records.slice(0, peek.lastSeq + 1),
    ...peek.calls.map(({ node, n, text, nextIndex }): Frame => {
      return ["call", null, { node, n, text, next_index: nextIndex }]
    }),
  ])
  const later = fed.slice(at)
  for (const frame of later) relay.frame(worker, frame)
  relay.detach(worker)
  const tail = await rest(it)
  // The frames as fed, chunks aside (a lagging stream's chunks of one call merge), then the log past the last record
  // fed, then run_end.
  const fedSeqs = later.filter((frame) => frame.type === "record").map((frame) => frame.seq as number)
  const want: Frame[] = []
  for (const frame of later) {
    const { type, node, n } = frame as { type: string; node: string; n: number }
    if (type === "record") want.push(records[frame.seq as number]!)
    else if (type === "start") {
      const { model, purpose, started_at } = frame
      want.push(["start", null, { node, n, model, purpose, started_at }])
    } else if (type === "end") want.push(["end", null, { node, n, error: frame.error }])
  }
  expect(fedSeqs.length).toBeGreaterThan(0)
  expect(want.filter(([event]) => event === "start" || event === "end").length).toBeGreaterThanOrEqual(3)
  want.push(...records.slice(Math.max(peek.lastSeq, ...fedSeqs) + 1), ["run_end", null, {}])
  expect(tail.filter(([event]) => event !== "chunk")).toEqual(want)
  // Every record once, in order: no gap, no duplicate.
  const seqs = [...head, ...tail]
    .filter(([event]) => event === "record")
    .map(([, , data]) => (data as { seq: number }).seq)
  expect(seqs).toEqual(records.map((_, seq) => seq))
  const texts = new Map(peek.calls.map((call) => [stepKey(call), call.text]))
  for (const [event, , data] of tail) {
    if (event === "chunk") texts.set(stepKey(data), (texts.get(stepKey(data)) ?? "") + (data as { text: string }).text)
  }
  expect(texts).toEqual(full)
})

test("a merged chunk carries its last index", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId, sessionId, log } = storedRun(office)
  const relay = liveRelay(office)
  const worker = stubWorker(runId, sessionId, log)
  const records = await recordFrames(log)
  const last = records.length - 1
  const calls = [{ node: "a", n: 1, chunks: ["x"], next_index: 1 }]
  relay.frame(worker, { type: "snapshot", snapshot: { last_seq: last, calls } })
  const it = frames(await open(sock, `/runs/${runId}/live`))
  expect(await read(it, 2 + last + 1)).toEqual([
    ["comment", null, "connected"],
    ...records,
    ["call", null, { node: "a", n: 1, text: "x", next_index: 1 }],
  ])
  // In one go, so they queue before the stream reads them.
  for (const [index, text] of ["b", "c", "d", "e"].entries()) {
    relay.frame(worker, { type: "chunk", node: "a", n: 1, index: index + 1, text })
  }
  relay.detach(worker)
  expect(await rest(it)).toEqual([
    ["chunk", null, { node: "a", n: 1, index: 4, text: "bcde" }],
    ["run_end", null, {}],
  ])
})

test("run end reads the log past the last seq sent", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId, sessionId, log } = storedRun(office)
  const relay = liveRelay(office)
  const worker = stubWorker(runId, sessionId, log)
  const records = await recordFrames(log)
  // The view stands four records before the log's end, as when the worker appended them without frames.
  const from = records.length - 5
  relay.frame(worker, { type: "snapshot", snapshot: { last_seq: from, calls: [] } })
  const it = frames(await open(sock, `/runs/${runId}/live`))
  expect(await read(it, 2 + from)).toEqual([["comment", null, "connected"], ...records.slice(0, from + 1)])
  const start = { node: "a", n: 1, model: null, purpose: "reply", started_at: "2026-10-20T10:00:00Z" }
  relay.frame(worker, { type: "start", ...start })
  relay.detach(worker)
  expect(await rest(it)).toEqual([["start", null, start], ...records.slice(from + 1), ["run_end", null, {}]])
})

test("a dropped viewer gets reset", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId, lastSeq, relay, worker } = joinedRun(office)
  const it = frames(await open(sock, `/runs/${runId}/live`))
  await read(it, 2 + lastSeq)
  // A record past the next seq is a gap: the relay drops the run's viewers.
  relay.frame(worker, { type: "record", seq: lastSeq + 100, line: "" })
  expect(await rest(it)).toEqual([["reset", null, null]])
})

test("a rebuilding view is joined again", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId, log, lastSeq, relay, worker } = joinedRun(office)
  relay.frame(worker, { type: "record", seq: lastSeq + 100, line: "" })
  expect(relay.join(runId)).toBe("rebuilding")
  const join = spyOn(relay, "join")
  const it = frames(await open(sock, `/runs/${runId}/live`))
  expect(await read(it, 1)).toEqual([["comment", null, "connected"]])
  await waitFor(() => join.mock.calls.length >= 2, { timeout: 5000, what: "a second join" })
  relay.frame(worker, { type: "snapshot", snapshot: { last_seq: lastSeq, calls: [] } })
  const records = await recordFrames(log)
  expect(await read(it, records.length)).toEqual(records)
  // A stream that had found no worker would have ended at run_end, without this frame.
  const start = { node: "a", n: 1, model: null, purpose: "reply", started_at: "2026-10-20T10:00:00Z" }
  relay.frame(worker, { type: "start", ...start })
  relay.detach(worker)
  expect(await rest(it)).toEqual([["start", null, start], ["run_end", null, {}]])
})

test("a stream waiting on a rebuild sends pings", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { pingMs: 50 })
  const { runId, lastSeq, relay, worker } = joinedRun(office)
  relay.frame(worker, { type: "record", seq: lastSeq + 100, line: "" })
  const it = frames(await open(sock, `/runs/${runId}/live`))
  expect(await read(it, 3)).toEqual([
    ["comment", null, "connected"],
    ["comment", null, "ping"],
    ["comment", null, "ping"],
  ])
  expect(relay.join(runId)).toBe("rebuilding")
})

test("a reconnect after the views seq skips the records it has", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId, sessionId, log } = storedRun(office)
  const relay = liveRelay(office)
  const worker = stubWorker(runId, sessionId, log)
  const records = await recordFrames(log)
  const from = records.length - 5
  relay.frame(worker, { type: "snapshot", snapshot: { last_seq: from, calls: [] } })
  const join = spyOn(relay, "join")
  const it = frames(await open(sock, `/runs/${runId}/live?after=${from + 2}`))
  expect(await read(it, 1)).toEqual([["comment", null, "connected"]])
  await waitFor(() => join.mock.calls.length > 0, { timeout: 5000, what: "the join" })
  // Without their lines: the relay reads each from the log.
  for (let seq = from + 1; seq <= from + 4; seq++) relay.frame(worker, { type: "record", seq })
  relay.detach(worker)
  expect(await rest(it)).toEqual([records[from + 3]!, records[from + 4]!, ["run_end", null, {}]])
})

test("a log behind the view gets reset and closes the viewer", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId, log, lastSeq, relay } = joinedRun(office)
  const records = await recordFrames(log)
  // The log loses its last three records after the view took them.
  const lines = fs.readFileSync(log, "utf8").split("\n")
  fs.writeFileSync(log, `${lines.slice(0, lastSeq - 2).join("\n")}\n`)
  const join = relay.join.bind(relay)
  const closes: Mock<() => void>[] = []
  spyOn(relay, "join").mockImplementation((id) => {
    const joined = join(id)
    if (joined !== null && joined !== "rebuilding") closes.push(spyOn(joined.viewer, "close"))
    return joined
  })
  const it = frames(await open(sock, `/runs/${runId}/live`))
  const kept = records.slice(0, lastSeq - 2)
  expect(await rest(it)).toEqual([["comment", null, "connected"], ...kept, ["reset", null, null]])
  expect(closes).toHaveLength(1)
  expect(closes[0]).toHaveBeenCalled()
})

test("a client that leaves closes its viewer", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId, lastSeq, relay } = joinedRun(office)
  const join = spyOn(relay, "join")
  const res = await open(sock, `/runs/${runId}/live`)
  await read(frames(res), 2 + lastSeq)
  const { viewer } = join.mock.results[0]!.value as LiveJoin
  const close = spyOn(viewer, "close")
  res.destroy()
  await waitFor(() => close.mock.calls.length > 0, { timeout: 5000, what: "the viewer to close" })
  expect(await viewer.next(1000)).toBeNull()
})

test("a ping keeps an idle live stream open", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { pingMs: 50 })
  const { runId, lastSeq, relay, worker } = joinedRun(office)
  const it = frames(await open(sock, `/runs/${runId}/live`))
  await read(it, 2 + lastSeq)
  expect(await read(it, 2)).toEqual([
    ["comment", null, "ping"],
    ["comment", null, "ping"],
  ])
  const start = { node: "a", n: 1, model: null, purpose: "reply", started_at: "2026-10-20T10:00:00Z" }
  relay.frame(worker, { type: "start", ...start })
  relay.detach(worker)
  const tail = await rest(it)
  expect(tail.filter(([event]) => event !== "comment")).toEqual([["start", null, start], ["run_end", null, {}]])
})

test("removing a device ends its live streams", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true, pingMs: 50 })
  const [mac, pc] = [newToken(), newToken()]
  giveDevice(office.paths.company, CEO, "mac", mac)
  giveDevice(office.paths.company, CEO, "pc", pc)
  const { runId, lastSeq } = joinedRun(office)
  const it = frames(await open(sock, `/runs/${runId}/live`, bearer(mac)))
  await read(it, 2 + lastSeq)
  expect((await request(sock, "DELETE", `/people/${CEO}/devices/mac`, { headers: bearer(pc) })).status).toBe(200)
  expect((await rest(it)).filter(([, , data]) => data !== "ping")).toEqual([])
})

test("removing a device cuts its live stream while the client is not reading", async () => {
  const office = makeOffice()
  const { sock, server } = await served(office, { tokens: true })
  const replies = repliesOf(server)
  const [mac, pc] = [newToken(), newToken()]
  giveDevice(office.paths.company, CEO, "mac", mac)
  giveDevice(office.paths.company, CEO, "pc", pc)
  // A log far past what a paused client's socket takes (a turn is over 1000 bytes; socket buffers differ by host), so
  // the stream waits for the client before its end.
  const capacity = await socketCapacity(Buffer.alloc(64 * 1024))
  const { runId } = storedRun(office, { turns: Math.max(3000, Math.ceil((2 * capacity) / 1000)) })
  const conn = await Conn.open(sock)
  conn.send(`GET /runs/${runId}/live HTTP/1.1\r\nhost: office\r\nauthorization: Bearer ${mac}\r\nconnection: close\r\n\r\n`)
  await waitFor(() => conn.socket.bytesRead > 0, { timeout: 9000, what: "the stream to start" })
  conn.socket.pause()
  await waitsForClient(() => replies[0])
  expect((await request(sock, "DELETE", `/people/${CEO}/devices/mac`, { headers: bearer(pc) })).status).toBe(200)
  const parts: Buffer[] = []
  await within(
    new Promise<void>((resolve) => {
      conn.socket.on("data", (part: Buffer) => parts.push(part))
      conn.socket.on("close", () => resolve())
      conn.socket.resume()
    }),
  )
  const got = Buffer.concat(parts).toString()
  expect(got.endsWith("0\r\n\r\n")).toBe(false)
  expect(got.includes("event: run_end")).toBe(false)
})

/** A run's model calls over the socket: GET /runs/{id}/calls?node= lists a node's calls and GET
 *  /runs/{id}/calls/{node}/{n} rebuilds one on the viewer thread (a 202 while it does), from real runs recorded
 *  against the fake model. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { RunCall, RunCallList } from "@opencorp/protocol"
import type { Office } from "../../../src/server/office.ts"
import { readCall } from "../../../src/runtime/runs/calls.ts"
import type { Replayed } from "../../../src/runtime/runs/replay.ts"
import { type ReplayJob, Replays } from "../../../src/runtime/runs/replays.ts"
import { RunLogs } from "../../../src/runtime/runs/service.ts"
import { newId } from "../../../src/runtime/store/store.ts"
import { FakeLLM } from "../../../src/testing/fake_llm.ts"
import { failedRun, gatedRun, interruptedRun, RUN_HEADER, RUN_KEY, RUN_ORG } from "../../runtime/runs/helpers.ts"
import { session } from "../../runtime/store/helpers.ts"
import { CEO, makeOffice, type Reply, replayed, request, served } from "../helpers.ts"

let dir: string
let gated: string
let interrupted: string
let failed: string
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-run-calls-"))
  const fake = await FakeLLM.start()
  try {
    gated = await gatedRun(fake, dir, "01JA1H00000000000000000C01")
    interrupted = await interruptedRun(fake, dir, "01JA1H00000000000000000C02")
    failed = await failedRun(fake, dir, "01JA1H00000000000000000C03")
  } finally {
    await fake.close()
  }
}, 30_000)
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

/** A store row of a new ended session for the run recorded at `log`, its log copied into the office's runs (with
 *  `edit` applied to its text); no log at all when `log` is null. Returns the run id. */
function place(office: Office, log: string | null, edit: (text: string) => string = (text) => text): string {
  const runId = log === null ? newId() : path.basename(path.dirname(log))
  const { id } = office.store.createSession(session({ status: "ended" }))
  office.store.addRun({
    runId,
    sessionId: id,
    driver: CEO,
    flow: "tools",
    flowPath: "shared/flows/tools.yaml",
    connection: null,
    model: null,
    configSha256: null,
    replacesRunId: null,
    createdAt: "2026-10-20T10:00:00.000Z",
  })
  if (log !== null) {
    const file = office.runs.logPath(runId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, edit(fs.readFileSync(log, "utf8")))
  }
  return runId
}

/** GET `target`, asked again while the office is still rebuilding a call for it. */
const get = (sock: string, target: string) => replayed(sock, target)
const body = (r: Reply) => r.json() as Record<string, unknown>

/** A viewer thread that holds each replay for `holdMs` first, as a long replay holds its thread: synchronously. */
const slowThread = (holdMs: number) => () =>
  new Worker(new URL("./slow_view_thread.ts", import.meta.url), { workerData: { holdMs } })

/** A served office whose viewer thread holds each replay for `holdMs`, and whose asks wait at most 50 ms. */
async function servedSlowly(holdMs: number, options: { callBytes?: number } = {}) {
  const office = makeOffice({ log: () => {} })
  office.runs = new RunLogs({
    store: office.store,
    runsDir: office.paths.runs,
    replays: new Replays({ start: slowThread(holdMs) }),
    waitMs: 50,
    ...options,
  })
  return { office, ...(await served(office)) }
}

test("a node's calls, and one call rebuilt with its request, reply, results and the gate's notes", async () => {
  const office = makeOffice({ log: () => {} })
  const { sock } = await served(office)
  const runId = place(office, gated)
  const list = await get(sock, `/runs/${runId}/calls?node=writer`)
  expect(list.status).toBe(200)
  const listed = RunCallList.parse(list.json()).calls
  expect(listed.map(({ n, attempts }) => [n, attempts])).toEqual([[1, 1], [8, 2]])
  // Each call's tool calls, by how they stand: the refused one is an error that yian closed.
  expect(listed.map((c) => c.tool_calls.map(({ name, outcome, closed }) => [name, outcome, closed]))).toEqual([
    [["lookup", "ok", null], ["save", "ok", null], ["wipe", "error", "refused"]],
    [],
  ])
  expect(listed[0]!.tool_calls.every((t) => t.result_n !== null && t.result_at !== null)).toBe(true)
  const r = await get(sock, `/runs/${runId}/calls/writer/1`)
  expect(r.status).toBe(200)
  const call = RunCall.parse(r.json())
  expect(call.request).toMatchObject({ system: "Be exact.", params: { provider: "vllm", model: "stub" } })
  expect(call.tool_results.map(({ name, note, held, release_note, closed }) => [name, note, held, release_note, closed]))
    .toEqual([
      ["lookup", "read-only", false, null, null],
      ["save", null, true, "approved by @ngocbh", null],
      ["wipe", null, false, null, "refused"],
    ])
  // A retried call by its first attempt.
  const retried = RunCall.parse((await get(sock, `/runs/${runId}/calls/writer/7`)).json())
  expect([retried.n, retried.attempts.map((a) => a.error?.kind ?? null)]).toEqual([8, ["incomplete", null]])
  // The run's key and the header value sent with it reach neither reply.
  for (const secret of [RUN_KEY, RUN_HEADER])
    expect([list.text.includes(secret), r.text.includes(secret), retried.n]).toEqual([false, false, 8])
})

test("an interrupted call says it was interrupted", async () => {
  const office = makeOffice({ log: () => {} })
  const { sock } = await served(office)
  const runId = place(office, interrupted)
  expect((body(await get(sock, `/runs/${runId}/calls?node=reply`)).calls as { finish: string }[])[0]!.finish)
    .toBe("interrupted")
  expect(body(await get(sock, `/runs/${runId}/calls/reply/1`))).toMatchObject({ finish: "interrupted", interrupted: true })
})

test("a call's settings show its endpoint and organization, never its key or the header sent with it", async () => {
  const office = makeOffice({ log: () => {} })
  const { sock } = await served(office)
  const r = await get(sock, `/runs/${place(office, failed)}/calls/reply/1`)
  expect(r.status).toBe(200)
  expect(RunCall.parse(r.json()).request!.params).toMatchObject({ organization: RUN_ORG, base_url: expect.any(String) })
  expect([r.text.includes(RUN_KEY), r.text.includes(RUN_HEADER)]).toEqual([false, false])
})

test("a bad id, node or n is a 404 or a 422 that doesn't echo it", async () => {
  const office = makeOffice({ log: () => {} })
  const { sock } = await served(office)
  const runId = place(office, gated)
  const status = async (target: string) => {
    const r = await get(sock, target)
    return [r.status, body(r).error]
  }
  expect(await status(`/runs/${newId()}/calls/writer/1`)).toEqual([404, "not_found"])
  expect(await status(`/runs/${newId()}/calls?node=writer`)).toEqual([404, "not_found"])
  expect(await status(`/runs/NOPE/calls/writer/1`)).toEqual([404, "not_found"])
  // A node the run doesn't have, of one segment or several, and a step of the node that is no call.
  for (const node of ["nope", "writer%2Fx", "a/b/writer", "writer%23"]) {
    const r = await get(sock, `/runs/${runId}/calls/${node}/1`)
    expect([r.status, body(r).error, r.text.includes("nope")]).toEqual([404, "not_found", false])
  }
  expect(await status(`/runs/${runId}/calls/writer/2`)).toEqual([404, "not_found"])
  expect(await status(`/runs/${runId}/calls/writer/..`)).toEqual([404, "no_route"])
  expect(await status(`/runs/${runId}/calls/../1`)).toEqual([404, "no_route"])
  for (const n of ["0", "-1", "1.5", "x", "9007199254740992"]) {
    const r = await get(sock, `/runs/${runId}/calls/writer/${n}`)
    expect([r.status, body(r).error, n === "0" || !r.text.includes(n)]).toEqual([422, "invalid_body", true])
  }
  // The list needs its node.
  expect(await status(`/runs/${runId}/calls`)).toEqual([422, "invalid_body"])
  expect(await status(`/runs/${runId}/calls?node=`)).toEqual([422, "invalid_body"])
  // A run with no log.
  expect(await status(`/runs/${place(office, null)}/calls/writer/1`)).toEqual([404, "no_log"])
})

test("a call isn't read on HEAD, since rebuilding one replays the log", async () => {
  const office = makeOffice({ log: () => {} })
  const { sock } = await served(office)
  const runId = place(office, gated)
  expect((await request(sock, "HEAD", `/runs/${runId}/calls/writer/1`)).status).toBe(405)
})

test("a log over the limit is too large to read its calls", async () => {
  const office = makeOffice({ log: () => {} })
  office.runs = new RunLogs({ store: office.store, runsDir: office.paths.runs, callBytes: 100 })
  const { sock } = await served(office)
  const runId = place(office, gated)
  for (const target of [`/runs/${runId}/calls?node=writer`, `/runs/${runId}/calls/writer/1`]) {
    const r = await get(sock, target)
    expect([r.status, body(r).error]).toEqual([409, "too_large"])
  }
})

test("while a call is rebuilt, its reads answer 202 at once and the office's other routes answer at once too", async () => {
  // Each replay holds its thread for 1.5 s, as a late call in a long chat does for much longer.
  const { office, sock } = await servedSlowly(1500)
  const runId = place(office, gated)
  const target = `/runs/${runId}/calls/writer/1`
  const started = performance.now()
  const first = await request(sock, "GET", target)
  expect([first.status, first.json()]).toEqual([202, { loading: true, retry_ms: 500 }])
  expect(first.headers["cache-control"]).toBe("no-store")
  // The office's own thread is free: another route answers while the call is still being rebuilt.
  const other = performance.now()
  expect((await request(sock, "GET", `/runs/${runId}`)).status).toBe(200)
  expect((await request(sock, "GET", `/runs/${runId}/calls?node=writer`)).status).toBe(200)
  const answered = performance.now() - other
  expect((await request(sock, "GET", target)).status).toBe(202)
  expect([answered < 500, performance.now() - started < 1500]).toEqual([true, true])
  // Asked again, it comes once rebuilt, as the call yian rebuilds; then it is kept, its node having ended.
  const done = await replayed(sock, target)
  expect(done.status).toBe(200)
  const fold = { env: () => undefined, codeRoot: null }
  expect(RunCall.parse(done.json())).toEqual(RunCall.parse(await readCall(office.runs.logPath(runId), "writer", 1, fold)))
  const again = performance.now()
  expect((await request(sock, "GET", target)).status).toBe(200)
  expect(performance.now() - again).toBeLessThan(500)
}, 30_000)

test("a live log that grows past the limit while its call waits for its turn is too large", async () => {
  const { office, sock } = await servedSlowly(1000, { callBytes: fs.statSync(gated).size + 10 })
  const runId = place(office, gated)
  const file = office.runs.logPath(runId)
  const target = `/runs/${runId}/calls/writer/1`
  expect((await request(sock, "GET", target)).status).toBe(202)
  // The run writes on, past the limit, while its thread holds the call.
  fs.appendFileSync(file, "x".repeat(100))
  const r = await replayed(sock, target)
  expect([r.status, body(r).error]).toEqual([409, "too_large"])
}, 30_000)

/** A host that remembers, for each ask, whether its result was to be kept. */
class KeepSpy extends Replays {
  readonly kept: boolean[] = []

  override ask<T extends Replayed>(key: string, job: ReplayJob, options: Parameters<Replays["ask"]>[2]) {
    this.kept.push(options.keep)
    return super.ask<T>(key, job, options)
  }
}

test("a call is kept only once its node has ended, when no later result or interrupt can change it", async () => {
  // The gated run cut before its agent's success: every tool call has its result, but the node runs on.
  const lines = fs.readFileSync(gated, "utf8").split("\n")
  const ended = lines.findIndex((l) => l.includes('"kind":"node_succeeded"') && l.includes('"node_id":"writer"'))
  expect(ended).toBeGreaterThan(0)
  const replays = new KeepSpy()
  const office = makeOffice({ log: () => {} })
  office.runs = new RunLogs({ store: office.store, runsDir: office.paths.runs, replays })
  const { sock } = await served(office)
  const runId = place(office, gated, () => `${lines.slice(0, ended).join("\n")}\n`)
  expect((await get(sock, `/runs/${runId}/calls/writer/1`)).status).toBe(200)
  expect(replays.kept).toEqual([false])
  // The node ends: now the call is kept.
  fs.writeFileSync(office.runs.logPath(runId), fs.readFileSync(gated))
  expect((await get(sock, `/runs/${runId}/calls/writer/1`)).status).toBe(200)
  expect(replays.kept.at(-1)).toBe(true)
})

test("past the queue's cap a call is refused as busy, a 503 with Retry-After", async () => {
  const office = makeOffice({ log: () => {} })
  office.runs = new RunLogs({ store: office.store, runsDir: office.paths.runs, replays: new Replays({ queueCap: 0 }) })
  const { sock } = await served(office)
  const runId = place(office, gated)
  const r = await request(sock, "GET", `/runs/${runId}/calls/writer/1`)
  expect([r.status, body(r).error, r.headers["retry-after"]]).toEqual([503, "busy", "5"])
  expect(body(r).message).toBe("the office is reading too many run logs at once; try again in a moment")
})

test("a call yian can't rebuild is a 409 naming only the error's type", async () => {
  const logged: string[] = []
  const office = makeOffice({ log: (line) => logged.push(line) })
  const { sock } = await served(office)
  // A recorded flow whose fingerprint no longer matches it: the list still reads, the rebuild refuses.
  const runId = place(office, gated, (text) => text.replace(/"flow_fingerprint":"[0-9a-f]{64}"/, `"flow_fingerprint":"${"0".repeat(64)}"`))
  expect((await get(sock, `/runs/${runId}/calls?node=writer`)).status).toBe(200)
  const r = await get(sock, `/runs/${runId}/calls/writer/1`)
  expect([r.status, body(r).error]).toEqual([409, "not_supported"])
  expect(body(r).message).toMatch(/^this office can't rebuild this model call \([A-Za-z]+\)$/)
  expect(logged.some((line) => line.includes(runId) && line.includes("couldn't rebuild this model call"))).toBe(true)
})

/** A run's model calls over the socket: GET /runs/{id}/calls?node= lists a node's calls and GET
 *  /runs/{id}/calls/{node}/{n} rebuilds one, from real runs recorded against the fake model. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { RunCall, RunCallList } from "@opencorp/protocol"
import type { Office } from "../../../src/server/office.ts"
import { RunLogReader } from "../../../src/runtime/runs/reader.ts"
import { RunLogs } from "../../../src/runtime/runs/service.ts"
import { newId } from "../../../src/runtime/store/store.ts"
import { FakeLLM } from "../../../src/testing/fake_llm.ts"
import { failedRun, gatedRun, interruptedRun, RUN_HEADER, RUN_KEY, RUN_ORG } from "../../runtime/runs/helpers.ts"
import { session } from "../../runtime/store/helpers.ts"
import { waitFor } from "../../helpers.ts"
import { CEO, makeOffice, type Reply, request, served } from "../helpers.ts"

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

const get = (sock: string, target: string) => request(sock, "GET", target)
const body = (r: Reply) => r.json() as Record<string, unknown>

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

/** A reader that counts the replays queued on it. */
class CountingReader extends RunLogReader {
  queued = 0

  override replay<T>(work: () => Promise<T>): Promise<T> {
    this.queued++
    return super.replay(work)
  }
}

test("a live log that grows past the limit while its call waits for the replays before it is too large", async () => {
  const office = makeOffice({ log: () => {} })
  const runId = place(office, gated)
  const file = office.runs.logPath(runId)
  const reader = new CountingReader()
  office.runs = new RunLogs({ store: office.store, runsDir: office.paths.runs, reader, callBytes: fs.statSync(file).size + 10 })
  const { sock } = await served(office)
  // Another replay holds the queue while the call's waits behind it.
  let free!: () => void
  const before = reader.replay(() => new Promise<void>((resolve) => (free = resolve)))
  const reply = get(sock, `/runs/${runId}/calls/writer/1`)
  await waitFor(() => reader.queued === 2, { what: "the call's replay to queue" })
  // The run writes on: part of a line, past the limit.
  fs.appendFileSync(file, "x".repeat(100))
  free()
  await before
  const r = await reply
  expect([r.status, body(r).error]).toEqual([409, "too_large"])
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
  expect(logged.some((line) => line.includes(runId) && line.includes("couldn't be rebuilt"))).toBe(true)
})

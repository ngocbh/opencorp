/** A run's model calls over the socket: GET /runs/{id}/calls?node= lists a node's calls and GET
 *  /runs/{id}/calls/{node}/{n} rebuilds one, from real runs recorded against the fake model. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { RunCall } from "@opencorp/protocol"
import type { Office } from "../../../src/server/office.ts"
import { RunLogs } from "../../../src/runtime/runs/service.ts"
import { newId } from "../../../src/runtime/store/store.ts"
import { FakeLLM } from "../../../src/testing/fake_llm.ts"
import { gatedRun, interruptedRun, RUN_KEY } from "../../runtime/runs/helpers.ts"
import { session } from "../../runtime/store/helpers.ts"
import { CEO, makeOffice, type Reply, request, served } from "../helpers.ts"

let dir: string
let gated: string
let interrupted: string
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-run-calls-"))
  const fake = await FakeLLM.start()
  try {
    gated = await gatedRun(fake, dir, "01JA1H00000000000000000C01")
    interrupted = await interruptedRun(fake, dir, "01JA1H00000000000000000C02")
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
  expect((body(list).calls as { n: number; attempts: number }[]).map(({ n, attempts }) => [n, attempts]))
    .toEqual([[1, 1], [8, 2]])
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
  // The run's key reaches neither reply.
  expect([list.text.includes(RUN_KEY), r.text.includes(RUN_KEY)]).toEqual([false, false])
})

test("an interrupted call says it was interrupted", async () => {
  const office = makeOffice({ log: () => {} })
  const { sock } = await served(office)
  const runId = place(office, interrupted)
  expect((body(await get(sock, `/runs/${runId}/calls?node=reply`)).calls as { finish: string }[])[0]!.finish)
    .toBe("interrupted")
  expect(body(await get(sock, `/runs/${runId}/calls/reply/1`))).toMatchObject({ finish: "interrupted", interrupted: true })
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

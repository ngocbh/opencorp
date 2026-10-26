/** Run Logs show a run's log and reasons as they are stored: records, node errors and the download untouched,
 *  reasons and node errors only cut for length. */
import fs from "node:fs"
import path from "node:path"
import type { Readable } from "node:stream"
import { expect, test } from "bun:test"
import { RunLogs } from "../../src/runs/service.ts"
import { newId, type Store } from "../../src/store/store.ts"
import { tempDir } from "../helpers.ts"
import { openStore, session } from "../store/helpers.ts"
import { committed, failed, runStarted, started, succeeded } from "./helpers.ts"

const T = "2026-10-20T10:00:00.000Z"
/** What the scrub used to hide: a provider key, a bearer token, a URL password, a device token and a password hash. */
const SECRETS = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 Bearer abcdefgh12345 " +
  "https://kai:hunter2hunter2@example.com act_" + "A".repeat(43) + " $argon2id$v=19$m=65536$c2FsdA$aGFzaA"

/** Run Logs over `store` and `runsDir`, and a run of an ended session with the office end `reason` (none: no end)
 *  and `log` as its log's bytes. */
function aRun(
  store: Store,
  runsDir: string,
  { reason, log = Buffer.alloc(0) }: { reason?: string; log?: Buffer } = {},
): { runs: RunLogs; runId: string } {
  const runs = new RunLogs({ store, runsDir, index: () => new Map() })
  const s = store.createSession(session({ status: "ended" }))
  const runId = newId()
  store.addSessionRun(s.id, runId)
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
  })
  if (reason !== undefined) store.endRun(runId, reason)
  const file = runs.logPath(runId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, log)
  return { runs, runId }
}

function secretLog(): Buffer {
  const value = { api_key: SECRETS, headers: { Authorization: SECRETS } }
  return Buffer.concat([
    runStarted(0),
    started(1, "chat"),
    committed(2, "chat", value),
    succeeded(3, "chat", 2),
    started(4, "chat"),
    failed(5, "chat", `401 for ${SECRETS}`),
  ])
}

async function bytesOf(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

test("records come back as stored", async () => {
  const log = secretLog()
  const { runs, runId } = aRun(openStore(), tempDir(), { log })
  const stored = JSON.parse(log.toString().split("\n")[2]!).payload
  const page = await runs.events(runId, { after: null, limit: 10 })
  expect(page.events[2]!.payload).toEqual(stored)
  expect((await runs.event(runId, 2)).payload).toEqual(stored)
  expect(page.events.every((e) => (e.withheld ?? null) === null)).toBe(true)
})

test("the download is the log byte for byte", async () => {
  const log = Buffer.concat([secretLog(), Buffer.from("not json\n")])
  const { runs, runId } = aRun(openStore(), tempDir(), { log })
  expect((await bytesOf(await runs.log(runId))).equals(log)).toBe(true)
})

test("a node error is only cut for length", async () => {
  const store = openStore()
  const runsDir = tempDir()
  let { runs, runId } = aRun(store, runsDir, { log: secretLog() })
  const page = await runs.nodes(runId, { before: null, limit: 10 })
  expect(page.nodes[0]!.error).toBe(`401 for ${SECRETS}`)
  const long = "x".repeat(150) + SECRETS
  const log = Buffer.concat([runStarted(0), started(1, "chat"), failed(2, "chat", long)])
  ;({ runs, runId } = aRun(store, runsDir, { log }))
  const { nodes } = await runs.nodes(runId, { before: null, limit: 10 })
  expect(nodes.map((n) => n.error)).toEqual([long.slice(0, 199) + "…"])
})

test("a reason is only cut for length", async () => {
  const store = openStore()
  const runsDir = tempDir()
  let { runs, runId } = aRun(store, runsDir, { reason: `401 for ${SECRETS}` })
  const { runs: listed } = runs.page()
  expect(listed.map((r) => [r.status, r.reason])).toEqual([["interrupted", `401 for ${SECRETS}`]])
  expect((await runs.detail(runId)).run.reason).toBe(`401 for ${SECRETS}`)
  const long = "y".repeat(150) + SECRETS
  ;({ runs, runId } = aRun(store, runsDir, { reason: long }))
  expect((await runs.detail(runId)).run.reason).toBe(long.slice(0, 199) + "…")
})

test("a stored cut is shown as stored", async () => {
  const { runs, runId } = aRun(openStore(), tempDir(), { reason: "worker stopped: hunter2hunt…" })
  expect((await runs.detail(runId)).run.reason).toBe("worker stopped: hunter2hunt…")
})

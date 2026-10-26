/** A run's reason is shown as stored, cut only for length: to the 200 shown, after any cut before it was stored
 *  (the store keeps 256). */
import { expect, test } from "bun:test"
import { Inspections, Live, Summaries, YianRuns } from "../../src/runs/records.ts"
import { RunLogs } from "../../src/runs/service.ts"
import { REASON_CHARS, newId, type Store } from "../../src/store/store.ts"
import { tempDir } from "../helpers.ts"
import { openStore, session } from "../store/helpers.ts"

const T = "2026-10-20T10:00:00.000Z"

function one(store: Store, reason: string): string {
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
  store.endRun(runId, reason)
  return runId
}

function shown(store: Store): string | null | undefined {
  const [row] = new RunLogs({ store, runsDir: tempDir(), index: () => new Map() }).page().runs
  return row!.reason
}

test.each([199, 200, 201, 256, 3000])("a reason is cut to the 200 shown [%s]", (length) => {
  const store = openStore()
  const reason = Array.from({ length }, (_, i) => String.fromCharCode(97 + (i % 26))).join("")
  one(store, reason)
  expect(shown(store)).toBe(length <= REASON_CHARS ? reason : reason.slice(0, REASON_CHARS - 1) + "…")
})

test("a reason cut before it was stored keeps its cut", () => {
  const store = openStore()
  const runId = one(store, "worker stopped: conn-key-5f3a…")
  const yian = new YianRuns(new Map(), new Inspections(tempDir()))
  const built = new Summaries(store, new Live(), yian).build([store.getRun(runId)!])
  expect(built.get(runId)!.reason).toBe("worker stopped: conn-key-5f3a…")
})

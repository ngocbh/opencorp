/** Every end path leaves the run's office row with only office facts: the office end reason it decided (none when
 *  yian ended the run), its end time, and the run a fresh run replaced (Python's `tests/runs/test_outcomes.py`). */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { HarnessError } from "../../src/chat/state.ts"
import {
  COULDNT_RESUME,
  COULDNT_START,
  NEW_MODEL,
  OFFICE_REPLACED,
  WORKER_REPLACED,
  WORKER_STOPPED,
} from "../../src/runs/outcomes.ts"
import { writePrivate } from "../../src/secrets.ts"
import { newId, type RunRow } from "../../src/store/store.ts"
import { type FakeLLM, LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import type { Frame } from "../../src/worker/channel.ts"
import { waitFor } from "../helpers.ts"
import { session as storedSession } from "../store/helpers.ts"
import {
  errors,
  fakeLlm,
  type HarnessOffice,
  LAN,
  makeHarness,
  running,
  noWorkersLeft,
  scriptedWorker,
  status,
  texts,
  unreadAtRestart,
} from "../chat/helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

// Shaped like an error type's name, so only redaction keeps it out of a log line's cause.
const KEY = "sk_outcome_key_0123456789"

/** Starts minh's chat and waits for its first turn; returns its id. */
async function start(h: HarnessOffice): Promise<string> {
  const s = await h.harness.startSession("minh", h.folder)
  await waitFor(() => status(h, s.id) === "idle", { what: "the first turn" })
  return s.id
}

/** The rows of session `sid`'s runs, in order; a run with no row is left out. */
function rows(h: HarnessOffice, sid: string): RunRow[] {
  return h.store.getSession(sid)!.run_ids.flatMap((runId) => h.store.getRun(runId) ?? [])
}

/** What `promise` rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  return promise.then(
    () => {
      throw new Error("expected a rejection")
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(HarnessError)
      return error as HarnessError
    },
  )
}

/** Waits until session `sid`'s worker runs no job: between turns it is parked, or gone. */
async function asleep(h: HarnessOffice, sid: string): Promise<void> {
  await waitFor(() => !running(h.registry, sid), { what: "the run call to end" })
}

/** Gives the office connection the model key `key`. */
async function rekey(h: HarnessOffice, key: string): Promise<void> {
  const file = path.join(h.office.connections.dir, "office.json")
  const provider = JSON.parse(fs.readFileSync(file, "utf8"))
  await writePrivate(file, JSON.stringify({ ...provider, llm_config: { ...provider.llm_config, api_key: key } }))
}

/** A harness whose office connection has the model key `KEY`. */
function keyed(fake: FakeLLM) {
  return makeHarness(fake, { llmConfig: { ...LLM_CONFIG, api_key: KEY } })
}

/** A `failed` result frame of run `runId`, failed with `failure`. */
function failedResult(runId: string, failure: Record<string, unknown>): Frame {
  return { type: "result", status: "failed", run_id: runId, output: null, failure, waits: [] }
}

test("an ended chat is finished with its end time", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Done." })
  const h = await makeHarness(fake)
  const sid = await start(h)
  await h.harness.prompt(sid, "hi")
  await waitFor(() => texts(h, sid).join() === "Done." && status(h, sid) === "idle", { what: "the reply" })
  await h.harness.end(sid)
  await waitFor(() => status(h, sid) === "ended", { what: "the end" })
  // The run succeeded: yian has its end, so the office writes none.
  expect(rows(h, sid)).toMatchObject([{ endReason: null, endedAt: null }])
})

test("a failed run says why and where without the providers key", async () => {
  const h = await keyed(await fakeLlm())
  const workers = scriptedWorker(h)
  const finished: Frame[] = []
  h.hooks.runFinished.push((_s, _runId, result) => void finished.push(result as Frame))
  const s = await h.harness.startSession("minh", h.folder)
  const { worker, handlers } = workers[0]!
  const message = `bad key ${KEY}; sent Bearer abcdefgh12345`
  // The worker may put the key anywhere: the cause's type and the details too.
  const failure = { node_id: "chat#0/reply", cause_type: `${KEY}AuthError`, message, details: [{ api_key: KEY }, KEY] }
  handlers.result(worker, failedResult(s.run_ids[0]!, failure))
  handlers.exited(worker, 1)
  await waitFor(() => workers.length === 2 && finished.length === 1, { what: "the fresh run" })
  const [old, fresh] = rows(h, s.id)
  expect(old).toMatchObject({ endReason: null, endedAt: null })
  expect(fresh).toMatchObject({ replacesRunId: old!.runId, endReason: null })
  expect(h.kinds).toEqual(["chat", "chat"])
  // Only the provider's key.
  const why = "[redacted]AuthError: bad key [redacted]; sent Bearer abcdefgh12345"
  expect(errors(h, s.id)).toEqual([
    `The reply failed (${why}). Send your message again. Check connection 'office', or pick another model with /model.`,
  ])
  expect(finished[0]!.failure).toEqual({
    node_id: "chat#0/reply",
    cause_type: "[redacted]AuthError",
    message: "bad key [redacted]; sent Bearer abcdefgh12345",
    details: [{ api_key: "[redacted]" }, "[redacted]"],
  })
  // A cause that isn't a type's name is logged as Error.
  expect(h.logs).toContain(`session ${s.id}: its reply failed (Error)`)
  const stored = [h.logs, h.store.getSession(s.id), rows(h, s.id), h.store.listQuestions({ sessionId: s.id })]
  expect(JSON.stringify(stored)).not.toContain(KEY)
})

test("a worker that cant start fails its run with couldnt start", async () => {
  const h = await makeHarness(await fakeLlm())
  h.failNextSpawn()
  await rejection(h.harness.startSession("minh", h.folder))
  const [s] = h.store.listSessions()
  expect(rows(h, s!.id)).toMatchObject([{ endReason: COULDNT_START }])
})

test("a second death fails the run with worker stopped", async () => {
  const h = await makeHarness(await fakeLlm())
  const workers = scriptedWorker(h)
  const s = await h.harness.startSession("minh", h.folder)
  workers[0]!.handlers.exited(workers[0]!.worker, 1)
  await waitFor(() => workers.length === 2, { what: "the retry" })
  workers[1]!.handlers.exited(workers[1]!.worker, 1)
  await waitFor(() => status(h, s.id) === "failed", { what: "the failure" })
  expect(rows(h, s.id)).toMatchObject([{ endReason: WORKER_STOPPED }])
})

test("a session restore cant rebuild fails its run", async () => {
  const h = await makeHarness(await fakeLlm())
  const sid = await start(h)
  await unreadAtRestart(h, sid)
  spyOn(h.harness, "spec").mockRejectedValue(new Error("the pin is gone"))
  await h.harness.restore()
  expect(status(h, sid)).toBe("failed")
  expect(rows(h, sid)).toMatchObject([{ endReason: COULDNT_RESUME }])
})

test("a restore whose resume cant spawn fails its run with couldnt resume", async () => {
  const h = await makeHarness(await fakeLlm())
  const sid = await start(h)
  await unreadAtRestart(h, sid)
  h.failNextSpawn()
  await h.harness.restore()
  expect(status(h, sid)).toBe("failed")
  expect(rows(h, sid)).toMatchObject([{ endReason: COULDNT_RESUME }])
})

test("a wake for its end that fails fails the run with couldnt resume", async () => {
  const h = await makeHarness(await fakeLlm())
  const sid = await start(h)
  await asleep(h, sid)
  h.failNextSpawn()
  await rejection(h.harness.end(sid))
  expect(status(h, sid)).toBe("failed")
  expect(rows(h, sid)).toMatchObject([{ endReason: COULDNT_RESUME }])
})

test("a wake that fails not for its end leaves its run open", async () => {
  const h = await makeHarness(await fakeLlm())
  const sid = await start(h)
  await asleep(h, sid)
  h.failNextSpawn()
  await rejection(h.harness.prompt(sid, "hi"))
  expect(status(h, sid)).toBe("idle")
  expect(rows(h, sid)).toMatchObject([{ endReason: null }])
})

test("an outcome and the sessions end commit together", async () => {
  const h = await makeHarness(await fakeLlm())
  const workers = scriptedWorker(h)
  const s = await h.harness.startSession("minh", h.folder)
  workers[0]!.handlers.exited(workers[0]!.worker, 1)
  await waitFor(() => workers.length === 2, { what: "the retry" })
  spyOn(h.store, "endRun").mockImplementation(() => {
    throw new Error("disk full")
  })
  workers[1]!.handlers.exited(workers[1]!.worker, 1)
  await waitFor(() => h.logs.some((line) => line.includes("can't store the end")), { what: "the failed end" })
  // Neither the session's end nor the run's is written.
  expect(status(h, s.id)).toBe("idle")
  expect(rows(h, s.id)).toMatchObject([{ endReason: null }])
  // The error's type only.
  expect(h.logs).toContain(`session ${s.id}: can't store the end (Error)`)
  expect(h.logs.join("\n")).not.toContain("disk full")
})

test("a failed reply fails its run and the fresh run replaces it", async () => {
  const fake = await fakeLlm()
  fake.script({ error: 500 }, { content: "Back." })
  const h = await makeHarness(fake)
  const seen: string[] = []
  h.hooks.runStarted.push((_s, runId) => void seen.push(`started ${runId}`))
  h.hooks.runFinished.push((_s, runId) => void seen.push(`finished ${runId}`))
  const sid = await start(h)
  await h.harness.prompt(sid, "hi")
  await waitFor(() => h.store.getSession(sid)!.run_ids.length === 2 && status(h, sid) === "idle", {
    what: "the new run",
  })
  const [old, fresh] = rows(h, sid)
  // yian recorded the failure: the office writes no end of its own.
  expect(old).toMatchObject({ endReason: null, endedAt: null })
  expect(fresh).toMatchObject({ replacesRunId: old!.runId, driver: old!.driver, endReason: null })
  // The old run is reported finished before the fresh one starts.
  await waitFor(() => seen.includes(`started ${fresh!.runId}`), { what: "the fresh run's start" })
  const finishedOld = seen.indexOf(`finished ${old!.runId}`)
  expect(finishedOld).toBeGreaterThanOrEqual(0)
  expect(finishedOld).toBeLessThan(seen.indexOf(`started ${fresh!.runId}`))
})

test("a failed reply whose fresh run cant start fails the session and the fresh run", async () => {
  const h = await makeHarness(await fakeLlm())
  const workers = scriptedWorker(h)
  const s = await h.harness.startSession("minh", h.folder)
  const { worker, handlers } = workers[0]!
  // The fresh run's spawn, after it was stored.
  spyOn(h.registry, "spawn").mockRejectedValueOnce(new Error("the spawn failed"))
  handlers.result(worker, failedResult(s.run_ids[0]!, { node_id: "chat#0/reply", message: "boom" }))
  handlers.exited(worker, 1)
  await waitFor(() => status(h, s.id) === "failed", { what: "the failure" })
  const [old, fresh] = rows(h, s.id)
  expect(old).toMatchObject({ endReason: null })
  expect(fresh).toMatchObject({ replacesRunId: old!.runId, endReason: COULDNT_START })
  expect(errors(h, s.id)).toEqual([
    "The reply failed (boom). Send your message again.",
    "The session failed (its worker stopped or couldn't start; see the office log). Start a new chat.",
  ])
})

test("a failed reply whose fresh run cant resolve its connection fails the session on the failed result", async () => {
  const h = await keyed(await fakeLlm())
  const workers = scriptedWorker(h)
  const finished: [string, Frame | null][] = []
  h.hooks.runFinished.push((_s, runId, result) => void finished.push([runId, result]))
  const s = await h.harness.startSession("minh", h.folder)
  const { worker, handlers } = workers[0]!
  // Not private: the connection is refused before anything of the fresh run is written.
  fs.chmodSync(path.join(h.office.connections.dir, "office.json"), 0o644)
  const result = failedResult(s.run_ids[0]!, { node_id: "chat#0/reply", message: `bad key ${KEY}` })
  handlers.result(worker, result)
  handlers.exited(worker, 1)
  await waitFor(() => status(h, s.id) === "failed" && finished.length === 1, { what: "the failure" })
  expect(h.store.getSession(s.id)!.run_ids).toEqual(s.run_ids)
  // The failed result ended the run: no office end reason.
  expect(rows(h, s.id)).toMatchObject([{ endReason: null, endedAt: null }])
  const redacted = { ...result, failure: { node_id: "chat#0/reply", message: "bad key [redacted]" } }
  expect(finished).toEqual([[s.run_ids[0]!, redacted]])
  expect(h.kinds).toEqual(["chat"])
})

test("a provider change interrupts the run it replaces", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "One." }, { content: "Two." })
  const h = await makeHarness(fake)
  const sid = await start(h)
  await rekey(h, "sk-a-new-key-0123456789")
  await h.harness.prompt(sid, "hi")
  await waitFor(() => h.store.getSession(sid)!.run_ids.length === 2, { what: "the fresh run" })
  const [old, fresh] = rows(h, sid)
  expect(old!.endReason).toBe(NEW_MODEL)
  expect(fresh).toMatchObject({ replacesRunId: old!.runId, createdAt: old!.endedAt! })
})

test("a crash resume on a new key says the worker stopped", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Working", hold: true })
  const h = await keyed(fake)
  const sid = await start(h)
  await h.harness.prompt(sid, "hi")
  await fake.waitForRequests(1)
  await rekey(h, "sk-another-key-0123456789")
  process.kill(-h.registry.get(sid)!.pgid, "SIGKILL")
  await waitFor(() => h.store.getSession(sid)!.run_ids.length === 2, { what: "the fresh run" })
  const [old, fresh] = rows(h, sid)
  expect(old!.endReason).toBe(WORKER_REPLACED)
  expect(fresh!.replacesRunId).toBe(old!.runId)
})

test("a wake on a new key interrupts the old run because the office stopped", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hi." })
  const h = await keyed(fake)
  const sid = await start(h)
  await asleep(h, sid)
  await h.reopen()
  await rekey(h, "sk-another-key-0123456789")
  // The idle session sleeps.
  await h.harness.restore()
  expect(h.registry.get(sid)).toBeUndefined()
  // Its wake finds the key changed: a fresh run.
  await h.harness.prompt(sid, "hi")
  await waitFor(() => h.store.getSession(sid)!.run_ids.length === 2, { what: "the fresh run" })
  const [old, fresh] = rows(h, sid)
  expect(old!.endReason).toBe(OFFICE_REPLACED)
  expect(fresh).toMatchObject({ replacesRunId: old!.runId, createdAt: old!.endedAt! })
})

test("a restore on a new key interrupts the old run because the office stopped", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "read it" })
  const h = await keyed(fake)
  const sid = await start(h)
  await unreadAtRestart(h, sid)
  await rekey(h, "sk-another-key-0123456789")
  // Its run must advance, but the key changed: a fresh run.
  await h.harness.restore()
  await waitFor(() => h.store.getSession(sid)!.run_ids.length === 2, { what: "the fresh run" })
  const [old, fresh] = rows(h, sid)
  expect(old!.endReason).toBe(OFFICE_REPLACED)
  expect(fresh!.replacesRunId).toBe(old!.runId)
})

test("a fresh run that never started couldnt start when the next wake replaces it", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "b's reply" })
  const h = await keyed(fake)
  const sid = await start(h)
  await asleep(h, sid)
  await h.reopen()
  // A fresh run.
  await rekey(h, "sk-another-key-0123456789")
  await h.harness.restore()
  h.failNextSpawn()
  // Its fresh run is recorded, then can't spawn, so it has no log.
  await rejection(h.harness.prompt(sid, "a"))
  await h.harness.prompt(sid, "b")
  await waitFor(() => texts(h, sid).includes("b's reply") && status(h, sid) === "idle", { what: "the reply to b" })
  const [a, b, c] = rows(h, sid)
  expect([a!.endReason, b!.endReason, c!.endReason]).toEqual([OFFICE_REPLACED, COULDNT_START, null])
  expect([b!.createdAt, c!.createdAt]).toEqual([a!.endedAt!, b!.endedAt!])
})

test("a fresh run after a run with no row is driven by the opener", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake, { files: LAN })
  const s = h.store.createSession(
    storedSession({ cwd: fs.realpathSync(h.folder), repo_commit: await h.office.git.head(), opened_by: "lan" }),
  )
  // Launched before rows were written, and with no log.
  const old = newId()
  h.store.addSessionRun(s.id, old)
  fake.script({ content: "Hi." })
  // The wake starts fresh: its run never started.
  await h.harness.prompt(s.id, "hello")
  await waitFor(() => h.store.getSession(s.id)!.run_ids.length === 2, { what: "the fresh run" })
  expect(rows(h, s.id)).toMatchObject([{ driver: "lan", replacesRunId: old, endReason: null }])
})

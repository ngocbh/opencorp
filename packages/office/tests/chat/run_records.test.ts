/** Run records: each chat run's connection and model, what a wake or a death's respawn checks, and a removed
 *  connection (Python's `tests/chat/test_run_records.py`). */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { now, OFFICE, Question } from "@opencorp/protocol"
import { ConnectionFile, runRecord } from "../../src/chat/connections.ts"
import type { SessionActor } from "../../src/chat/session_actor.ts"
import { COULDNT_START } from "../../src/runs/outcomes.ts"
import { writePrivate } from "../../src/secrets.ts"
import { newId } from "../../src/store/store.ts"
import { type FakeLLM, LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import type { Job } from "../../src/worker/job.ts"
import type { Worker } from "../../src/worker/spawn.ts"
import { waitFor } from "../helpers.ts"
import {
  type ChatOffice,
  chatOffice,
  fakeLlm,
  makeActor,
  newSession,
  noWorkersLeft,
  reopen,
  say,
  session,
  startActor,
  status,
} from "./helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

const KEY = "sk-record-test-0e7c"
const FRESH =
  "This chat continues on a fresh run because its model or connection changed. " +
  "If your last message got no reply, send it again."
const REMOVED = "Connection 'second' was removed; this chat now uses office/stub."
const WOKEN = "This chat continues on a fresh run because its model or connection changed."

/** Wakes a sleeping session with a message; resolves with its reply once the session is idle. */
function wake(o: ChatOffice, fake: FakeLLM, actor: SessionActor, sid: string): Promise<string> {
  fake.script({ content: "woken" })
  return say(o, actor, sid, "wake up")
}

/** The runs row of session `sid`'s latest run: its record. */
function recordOf(o: ChatOffice, sid: string) {
  return o.office.store.getRun(session(o, sid).run_ids.at(-1)!)!
}

/** What a run on connection `name` and `model` would record now. */
async function recordNow(o: ChatOffice, name: string, model: string | null) {
  return runRecord(name, model, await o.office.connections.resolve(name, model))
}

/** Rewrites the office connection on `fake` with `llm` over `LLM_CONFIG`, as `opencorp onboard` would. */
async function rewriteOffice(o: ChatOffice, fake: FakeLLM, llm: Record<string, unknown>): Promise<void> {
  const provider = { llm_config: { ...LLM_CONFIG, ...llm }, env: fake.env(), prices: {} }
  await writePrivate(path.join(o.office.connections.dir, "office.json"), JSON.stringify(provider))
}

/** Puts session `sid` on connection `name` and `model`, as a switch would. */
function on(o: ChatOffice, sid: string, name: string, model: string | null = null): void {
  o.office.store.updateSession(sid, { connection: name, model })
}

/** Each job's kind and its llm_config's `field`. */
function seen(jobs: Job[], field: string): unknown[][] {
  return jobs.map((job) => [job.kind, job.llm_config?.[field]])
}

/** Sends `text` with the fake holding its reply; resolves with the worker running it once the model call is held. */
async function holding(o: ChatOffice, fake: FakeLLM, actor: SessionActor, text: string): Promise<Worker> {
  await waitFor(() => !actor.hasWorker, { what: "the last worker to exit" })
  const spawned: Worker[] = []
  o.afterSpawn((worker) => void spawned.push(worker))
  const n = fake.requests().length
  fake.script({ content: "held", hold: true })
  await actor.prompt(text)
  await fake.waitForRequests(n + 1, 30_000)
  return spawned[0]!
}

/** Kills `worker`'s process group, as a crash would. */
function killed(worker: Worker): void {
  process.kill(-worker.pgid, "SIGKILL")
}

/** Kills `worker` and waits for the respawn after its death to rest at a turn; returns the jobs spawned since. */
async function kill(o: ChatOffice, actor: SessionActor, sid: string, worker: Worker): Promise<Job[]> {
  const before = o.jobs.length
  killed(worker)
  await waitFor(() => o.jobs.length > before && status(o, sid) === "idle" && !actor.hasWorker, {
    what: "the worker after the kill",
  })
  return o.jobs.slice(before)
}

/** The run ids `o`'s `runFinished` hook announces from now on, in order. */
function announced(o: ChatOffice): string[] {
  const runs: string[] = []
  o.hooks.runFinished.push((_session, runId) => void runs.push(runId))
  return runs
}

/** Makes `o`'s store fail to add a run to a session. */
function unrecorded(o: ChatOffice): void {
  o.office.store.addSessionRun = () => {
    throw new Error("disk full")
  }
}

/** What `promise` was refused with: its status and code. */
function refusal(promise: Promise<unknown>): Promise<unknown[]> {
  return promise.then(
    () => [],
    (error) => [error.status, error.code],
  )
}

test("each new run has a record before its worker starts", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { llmConfig: { ...LLM_CONFIG, api_key: KEY } })
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  const held = o.hold()
  const started = actor.start()
  await held.entered
  const row = o.office.store.getRun(actor.runId!)
  expect(o.kinds).toEqual(["chat"])
  expect(row).toMatchObject(await recordNow(o, OFFICE, null))
  expect(row?.model).toBeNull()
  expect(JSON.stringify(row)).not.toContain(KEY)
  held.release()
  await started
})

test("a failed record write fails the spawn", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  o.office.store.setRunConfig = () => {
    throw new Error("disk full")
  }
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  const error = await actor.start().then(
    () => null,
    (e) => e,
  )
  expect([error.status, error.code, status(o, sid), o.kinds]).toEqual([500, "start_failed", "failed", []])
  expect(error.message).toContain("failed to start")
  expect(actor.hasWorker).toBe(false)
})

test("restore resumes a run whose record matches", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  await say(o, first, sid, "a")
  const second = await reopen(o, first)
  const before = o.kinds.length
  expect(await say(o, second, sid, "b")).toBe("two")
  expect(o.kinds.slice(before)).toEqual(["advance"])
  const stored = session(o, sid)
  expect([stored.run_ids.length, stored.model_note]).toEqual([1, null])
})

test("restore after the key changed starts a fresh run with a note", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { llmConfig: { ...LLM_CONFIG, api_key: KEY } })
  const { actor: first, sid } = await startActor(o)
  const second = await reopen(o, first)
  await rewriteOffice(o, fake, { api_key: "sk-another-key" })
  const notes: unknown[] = []
  onTestFinished(
    o.office.store.addListener((event) => {
      if (event.type === "session.updated") notes.push((event.data as { model_note?: unknown }).model_note)
    }),
  )
  const before = o.jobs.length
  await wake(o, fake, second, sid)
  expect(seen(o.jobs.slice(before), "api_key")).toEqual([["chat", "sk-another-key"]])
  const stored = session(o, sid)
  expect([stored.run_ids.length, stored.model_note]).toEqual([2, WOKEN])
  // Clients hear of it.
  expect(notes).toContain(WOKEN)
  expect(recordOf(o, sid).configSha256).toBe((await recordNow(o, OFFICE, null)).configSha256)
})

test("restore after the endpoint changed starts a fresh run", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { llmConfig: { ...LLM_CONFIG, api_key: KEY } })
  const { actor: first, sid } = await startActor(o)
  const second = await reopen(o, first)
  // The same fake, named as a base_url, which yian sends the key to.
  await rewriteOffice(o, fake, { base_url: `${fake.baseUrl}/v1`, api_key: KEY })
  const before = o.kinds.length
  await wake(o, fake, second, sid)
  expect(o.kinds.slice(before)).toEqual(["chat"])
  expect(session(o, sid).run_ids).toHaveLength(2)
})

test("a crash resume checks the record too", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { llmConfig: { ...LLM_CONFIG, api_key: KEY } })
  const { actor, sid } = await startActor(o)
  const worker = await holding(o, fake, actor, "a")
  await rewriteOffice(o, fake, { api_key: "sk-another-key" })
  const jobs = await kill(o, actor, sid, worker)
  expect(seen(jobs, "api_key")).toEqual([["chat", "sk-another-key"]])
  const stored = session(o, sid)
  expect([stored.run_ids.length, stored.model_note]).toEqual([2, FRESH])
})

test("a crash resume whose record matches resumes", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  const worker = await holding(o, fake, actor, "a")
  // The resumed reply calls the model again.
  fake.script({ content: "after" })
  const jobs = await kill(o, actor, sid, worker)
  expect(jobs.map((job) => job.kind)).toEqual(["advance"])
  expect(session(o, sid).model_note).toBeNull()
})

test("a session on a second connection runs on it", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { connections: { second: "stub-2" } })
  fake.script({ content: "on two" })
  const { actor, sid } = await startActor(o)
  on(o, sid, "second")
  expect(await say(o, actor, sid, "hi")).toBe("on two")
  expect(fake.requests().at(-1)!.model).toBe("stub-2")
  expect([recordOf(o, sid).connection, recordOf(o, sid).model]).toEqual(["second", null])
  expect(session(o, sid).run_ids).toHaveLength(2)
})

test("a session on a model of its connection runs on that model", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  fake.script({ content: "on three" })
  const { actor, sid } = await startActor(o)
  on(o, sid, OFFICE, "stub-3")
  expect(await say(o, actor, sid, "hi")).toBe("on three")
  expect(fake.requests().at(-1)!.model).toBe("stub-3")
  expect([recordOf(o, sid).connection, recordOf(o, sid).model]).toEqual([OFFICE, "stub-3"])
})

test("a removed connection moves the chat to the default on its next turn", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { connections: { second: "stub-2" } })
  fake.script({ content: "from two", hold: true }, { content: "from one" })
  const { actor, sid } = await startActor(o)
  on(o, sid, "second")
  await actor.prompt("a")
  await fake.waitForRequests(1)
  await o.office.connections.remove("second")
  // A running reply keeps the key it has.
  fake.release()
  await waitFor(() => status(o, sid) === "idle" && !actor.hasWorker, { what: "the held reply" })
  expect(fake.requests().at(-1)!.model).toBe("stub-2")

  expect(await say(o, actor, sid, "b")).toBe("from one")
  expect(fake.requests().at(-1)!.model).toBe("stub")
  const stored = session(o, sid)
  expect([stored.connection, stored.model]).toEqual([OFFICE, null])
  expect(stored.model_note).toBe(REMOVED)
  expect(recordOf(o, sid).connection).toBe(OFFICE)
})

test("a crash resume after removal moves to the default", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { connections: { second: "stub-2" } })
  const { actor, sid } = await startActor(o)
  on(o, sid, "second")
  const worker = await holding(o, fake, actor, "a")
  await o.office.connections.remove("second")
  const jobs = await kill(o, actor, sid, worker)
  expect(seen(jobs, "model")).toEqual([["chat", "stub"]])
  const stored = session(o, sid)
  expect([stored.connection, stored.model, stored.run_ids.length]).toEqual([OFFICE, null, 3])
  // Says more than the fresh-run note.
  expect(stored.model_note).toBe(REMOVED)
  expect(recordOf(o, sid).connection).toBe(OFFICE)
})

test("a wake after removal keeps the removal note", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { connections: { second: "stub-2" } })
  fake.script({ content: "from two" }, { content: "on office" })
  const { actor: first, sid } = await startActor(o)
  on(o, sid, "second")
  await say(o, first, sid, "a")
  const second = await reopen(o, first)
  await o.office.connections.remove("second")
  const before = o.jobs.length
  // The wake moves it to the default.
  expect(await say(o, second, sid, "b")).toBe("on office")
  expect(seen(o.jobs.slice(before), "model")).toEqual([["chat", "stub"]])
  const stored = session(o, sid)
  expect([stored.connection, stored.model_note]).toEqual([OFFICE, REMOVED])
})

test("the key change on the same name restarts on the next turn", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { connections: { second: "stub-2" } })
  fake.script({ content: "one" }, { content: "two" })
  const { actor, sid } = await startActor(o)
  on(o, sid, "second")
  await say(o, actor, sid, "a")
  const before = recordOf(o, sid)
  const { connections } = o.office
  const conn = await connections.get("second")
  await connections.put(
    "second",
    ConnectionFile.parse({ llm_config: { ...conn.llm_config, api_key: KEY }, env: { ...conn.env } }),
  )
  const n = o.jobs.length
  expect(await say(o, actor, sid, "b")).toBe("two")
  expect(seen(o.jobs.slice(n), "api_key")).toEqual([["chat", KEY]])
  const after = recordOf(o, sid)
  expect(session(o, sid).run_ids).toHaveLength(3)
  expect(after.connection).toBe("second")
  expect(after.configSha256).not.toBe(before.configSha256)
  expect(after.configSha256).toBe((await recordNow(o, "second", null)).configSha256)
})

test("restore after a model change starts a fresh run on it", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  on(o, sid, OFFICE, "stub-3")
  const second = await reopen(o, first)
  const before = o.jobs.length
  await wake(o, fake, second, sid)
  expect(seen(o.jobs.slice(before), "model")).toEqual([["chat", "stub-3"]])
  expect(session(o, sid).model_note).toBe(WOKEN)
})

test("a crash resume after a model change starts a fresh run on it", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  const worker = await holding(o, fake, actor, "a")
  on(o, sid, OFFICE, "stub-3")
  const jobs = await kill(o, actor, sid, worker)
  expect(seen(jobs, "model")).toEqual([["chat", "stub-3"]])
  expect(session(o, sid).model_note).toBe(FRESH)
})

test("a resume runs on what its check passed even if the choice changes meanwhile", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { connections: { second: "stub-2" } })
  const { actor, sid } = await startActor(o)
  const worker = await holding(o, fake, actor, "a")
  fake.script({ content: "after" })
  const { connections } = o.office
  const resolve = connections.resolve.bind(connections)
  let switched = false
  connections.resolve = async (name, model) => {
    const provider = await resolve(name, model)
    if (!switched) {
      switched = true
      // A switch between the check and the spawn.
      on(o, sid, "second")
    }
    return provider
  }
  const jobs = await kill(o, actor, sid, worker)
  expect(switched).toBe(true)
  expect(seen(jobs, "model")).toEqual([["advance", "stub"]])
})

test("a crash resume that cant read where the chat goes fails without a new run", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { connections: { second: "stub-2" } })
  const { actor, sid } = await startActor(o)
  on(o, sid, "second")
  const worker = await holding(o, fake, actor, "a")
  const runs = session(o, sid).run_ids
  await o.office.connections.remove("second")
  // So the chat can't be moved.
  await writePrivate(path.join(o.office.connections.dir, "_default.json"), "{}")
  killed(worker)
  await waitFor(() => status(o, sid) === "failed", { what: "the failed session" })
  const stored = session(o, sid)
  expect([stored.run_ids, stored.model_note, stored.connection]).toEqual([runs, null, "second"])
  expect(actor.hasWorker).toBe(false)
})

test("a wake whose fresh run cant be recorded answers 503 and leaves the session idle", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { llmConfig: { ...LLM_CONFIG, api_key: KEY } })
  const { actor: first, sid } = await startActor(o)
  const second = await reopen(o, first)
  await rewriteOffice(o, fake, { api_key: "sk-another-key" })
  const old = session(o, sid).run_ids
  unrecorded(o)
  expect(await refusal(second.prompt("a"))).toEqual([503, "cant_wake"])
  expect(status(o, sid)).toBe("idle")
  expect(second.hasWorker).toBe(false)
  expect(session(o, sid).run_ids).toEqual(old)
  // The old run isn't ended.
  expect(o.office.store.getRun(old.at(-1)!)?.endReason).toBeNull()
})

test("a fresh run that cant be recorded fails the session after a crash", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { llmConfig: { ...LLM_CONFIG, api_key: KEY } })
  const { actor, sid } = await startActor(o)
  const worker = await holding(o, fake, actor, "a")
  await rewriteOffice(o, fake, { api_key: "sk-another-key" })
  const old = session(o, sid).run_ids
  const finished = announced(o)
  unrecorded(o)
  killed(worker)
  await waitFor(() => status(o, sid) === "failed", { what: "the failed session" })
  expect(actor.hasWorker).toBe(false)
  // The run that died, once; never a run the session didn't record.
  await waitFor(() => finished.length > 0, { what: "the announced run" })
  expect(finished).toEqual(old)
})

test("a restart that cant record its run announces the old run once", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { llmConfig: { ...LLM_CONFIG, api_key: KEY } })
  const { actor, sid } = await startActor(o)
  await waitFor(() => !actor.hasWorker, { what: "the first worker to exit" })
  const old = session(o, sid).run_ids
  await rewriteOffice(o, fake, { api_key: "sk-another-key" })
  const finished = announced(o)
  unrecorded(o)
  // The key changed, so a fresh run would take it; a message to a sleeping session is a wake.
  expect(await refusal(actor.prompt("a"))).toEqual([503, "cant_wake"])
  expect(status(o, sid)).toBe("idle")
  expect(actor.hasWorker).toBe(false)
  expect(finished).toEqual([])
  expect(session(o, sid).run_ids).toEqual(old)
})

test("a wake whose fresh run note cant be written answers 503 and leaves the session idle", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { llmConfig: { ...LLM_CONFIG, api_key: KEY } })
  const { actor: first, sid } = await startActor(o)
  const second = await reopen(o, first)
  await rewriteOffice(o, fake, { api_key: "sk-another-key" })
  const old = session(o, sid).run_ids
  const { store } = o.office
  const update = store.updateSession.bind(store)
  store.updateSession = (sessionId, changes) => {
    if ("model_note" in changes) throw new Error("disk full")
    return update(sessionId, changes)
  }
  expect(await refusal(second.prompt("a"))).toEqual([503, "cant_wake"])
  expect(status(o, sid)).toBe("idle")
  expect(second.hasWorker).toBe(false)
  expect(session(o, sid).run_ids).toEqual(old)
  expect(store.getRun(old.at(-1)!)?.endReason).toBeNull()
})

test("a removed connection stops serving turns even when the default cant be used", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { connections: { second: "stub-2" } })
  fake.script({ content: "from two" }, { content: "still from two" })
  const { actor, sid } = await startActor(o)
  on(o, sid, "second")
  await say(o, actor, sid, "a")
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  const n = fake.requests().length
  await o.office.connections.remove("second")
  // The default, office, refuses it.
  fs.chmodSync(path.join(o.office.connections.dir, "office.json"), 0o644)
  expect(await refusal(actor.prompt("b"))).toEqual([503, "cant_wake"])
  // The removed key sent nothing more.
  expect(fake.requests()).toHaveLength(n)
  const stored = session(o, sid)
  // Nothing is written when the default can't be resolved: no removal note.
  expect([stored.connection, stored.model_note, stored.status]).toEqual(["second", null, "idle"])
  expect(actor.hasWorker).toBe(false)
})

test("a run with no log starts fresh without a note", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  const second = await reopen(o, first)
  const old = second.runId!
  // Its worker never started.
  fs.rmSync(path.join(o.office.paths.runs, old, "log.jsonl"))
  const before = o.kinds.length
  await wake(o, fake, second, sid)
  const stored = session(o, sid)
  expect(o.kinds.slice(before)).toEqual(["chat"])
  expect([stored.run_ids.length, stored.model_note]).toEqual([2, null])
  expect(o.office.store.getRun(old)?.endReason).toBe(COULDNT_START)
})

test("a fresh run that cant be recorded leaves the old runs questions open", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { llmConfig: { ...LLM_CONFIG, api_key: KEY } })
  const { actor, sid } = await startActor(o)
  await waitFor(() => !actor.hasWorker, { what: "the first worker to exit" })
  const old = actor.runId!
  await rewriteOffice(o, fake, { api_key: "sk-another-key" })
  const t = now()
  const { store } = o.office
  const question = store.addQuestion(
    Question.parse({
      id: newId(),
      session_id: sid,
      run_id: old,
      node_id: "gate",
      source: "ask",
      asker: "minh",
      question: "Which db?",
      status: "open",
      created_at: t,
      updated_at: t,
    }),
  )
  unrecorded(o)
  // The key changed, so a fresh run would take it.
  expect(await refusal(actor.prompt("a"))).toEqual([503, "cant_wake"])
  // Nothing was staled before the recording failed.
  expect(store.getQuestion(question.id)?.status).toBe("open")
})

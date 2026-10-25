/** Moving a run on in a new worker: a killed run resumes, and an advance yian refuses before it appends is reported
 *  `not_resumed`. */
import fs from "node:fs"
import path from "node:path"
import { FileMarkdownStore, RunBusyError } from "@ngocbh/yian"
import { inspectRun } from "@ngocbh/yian/run"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { killGroup } from "../../src/install/proc.ts"
import { type FakeLLM, LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import type { Job, JobInput } from "../../src/worker/job.ts"
import { advanceAppended, EXIT_FAILED, notResumed } from "../../src/worker/main.ts"
import type { WorkerHandlers } from "../../src/worker/rpc.ts"
import { fakeLlm } from "../chat/helpers.ts"
import { openStore } from "../store/helpers.ts"
import {
  advanceJob,
  base,
  inProcessWorker,
  makeJob,
  makeRegistry,
  Recorder,
  run,
  runWorker,
  type TestWorker,
} from "./helpers.ts"

setDefaultTimeout(60_000)

/** The `toolbox` group with one `shout` spec described as `description`. */
function shout(description: string): JobInput["groups"] {
  return {
    toolbox: [
      {
        name: "shout",
        description,
        parameters: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
      },
    ],
  }
}

/** Starts `job` in an in-process worker with `handlers`, holds its model call and stops it; the run is then
 *  stopped. */
async function stoppedRun(fake: FakeLLM, job: Job, handlers: WorkerHandlers<TestWorker> = new Recorder()) {
  onTestFinished(() => fake.release())
  fake.script({ content: "lost", hold: true })
  const worker = await inProcessWorker(job, handlers, { env: fake.env() })
  await fake.waitForRequests(1, 30_000)
  expect(await worker.stop()).toBe(true)
  expect(await worker.wait()).toBe(EXIT_FAILED)
  expect(inspectRun(job.log).status).toBe("stopped")
  fake.release()
}

/** Advances `job` in process with `env`; expects a `not_resumed` result naming `errorType` and a log the advance
 *  left as it was. */
async function expectNotResumed(job: Job, errorType: string, env: Record<string, string> = {}): Promise<void> {
  const before = fs.readFileSync(job.log, "utf8")
  const rec = await run(job, new Recorder(), { env })
  expect(rec.order).toEqual(["result"])
  expect(rec.outcome).toEqual({ type: "result", status: "not_resumed", run_id: "r1", error_type: errorType })
  expect(fs.readFileSync(job.log, "utf8")).toBe(before)
}

test("a killed run resumes in a new worker", async () => {
  const fake = await fakeLlm()
  const where = base()
  const store = openStore()
  const registry = makeRegistry(store)
  const sessionDir = path.join(where.root, "sessions", "s1")
  const job = makeJob(where)
  fake.script({ content: "lost", hold: true })
  const worker = await registry.spawn(job, sessionDir, new Recorder(), { env: fake.env() })
  await fake.waitForRequests(1, 30_000)
  killGroup(worker.pgid)
  expect(await worker.wait(10_000)).toBe(-9)
  expect(registry.get("s1")).toBeUndefined()
  expect(store.listWorkers()).toEqual([])
  fake.release()
  fake.script({ content: "recovered" })
  const rec = await runWorker(registry, advanceJob(job), new Recorder(), sessionDir, { env: fake.env() })
  expect([rec.returncode, rec.outcome?.status, rec.outcome?.run_id, rec.outcome?.output]).toEqual([
    0,
    "succeeded",
    "r1",
    "recovered",
  ])
})

test("a killed run whose provider has a key resumes with that key", async () => {
  const fake = await fakeLlm()
  const where = base()
  const registry = makeRegistry(openStore())
  const sessionDir = path.join(where.root, "sessions", "s1")
  const key = "sk-test-resume-0123456789"
  const job = makeJob(where, undefined, { llm_config: { ...LLM_CONFIG, base_url: `${fake.baseUrl}/v1`, api_key: key } })
  fake.script({ content: "lost", hold: true })
  const worker = await registry.spawn(job, sessionDir, new Recorder(), { env: {} })
  await fake.waitForRequests(1, 30_000)
  killGroup(worker.pgid)
  expect(await worker.wait(10_000)).toBe(-9)
  fake.release()
  fake.script({ content: "recovered" })
  const rec = await runWorker(registry, advanceJob(job), new Recorder(), sessionDir, { env: {} })
  expect([rec.outcome?.status, rec.outcome?.output]).toEqual(["succeeded", "recovered"])
  expect(fake.authorizations().at(-1)).toBe(`Bearer ${key}`)
})

test("a not resumed advance refuses the deliveries it still holds", async () => {
  const fake = await fakeLlm()
  const chat = makeJob(base(), "flows/steerable.yaml", { groups: shout("Shouts the text.") })
  await stoppedRun(fake, chat)
  // Offline, the interrupt waits for RunResumed, which a refused advance never writes.
  const job = advanceJob(chat, {
    groups: shout("Whispers the text."),
    deliver: [{ id: "i1", op: "interrupt", inbox: "steers" }],
  })
  const rec = await run(job, new Recorder(), { env: fake.env() })
  expect(rec.order).toEqual(["deliver_reply", "result"])
  expect(rec.replies).toEqual([{ type: "deliver_reply", id: "i1", refused: "not_started" }])
  expect(rec.outcome).toEqual({ type: "result", status: "not_resumed", run_id: "r1", error_type: "RangeError" })
})

test("an advance whose code file is gone is not resumed", async () => {
  const where = base()
  const chat = makeJob(where, "flows/coded.yaml", { inputs: {} })
  expect((await run(chat, new Recorder())).outcome?.status).toBe("waiting")
  fs.rmSync(path.join(where.pin, "flows", "helpers.ts"))
  await expectNotResumed(advanceJob(chat), "LoadError")
})

test("an advance refused for a changed tool spec is not resumed", async () => {
  const fake = await fakeLlm()
  const chat = makeJob(base(), "flows/tools.yaml", { groups: shout("Shouts the text.") })
  await stoppedRun(fake, chat)
  await expectNotResumed(advanceJob(chat, { groups: shout("Whispers the text.") }), "RangeError", fake.env())
})

test("an advance whose memory cannot be rebuilt is not resumed", async () => {
  const fake = await fakeLlm()
  const where = base()
  const profile = path.join(where.root, "profile.md")
  fs.writeFileSync(profile, "# Minh\nPrefers terse answers.\n")
  const chat = makeJob(where, "flows/profiled.yaml", { memory: { profile: { store: "minh-profile" } } })
  await stoppedRun(fake, chat, new Recorder({ stores: { "minh-profile": new FileMarkdownStore(profile) } }))
  await expectNotResumed(advanceJob(chat, { memory: {} }), "MemorySetupError", fake.env())
})

test("an advance whose yian settings differ is not resumed", async () => {
  const fake = await fakeLlm()
  const chat = makeJob(base())
  await stoppedRun(fake, chat)
  await expectNotResumed(advanceJob(chat), "DefaultsMismatchError", { ...fake.env(), YIAN_MAX_EVENT_BYTES: "12345" })
})

test("a refusal after the advance appended a record is an error", () => {
  expect(notResumed(new RangeError("x"), true)).toBe(false)
  expect(notResumed(new RangeError("x"), false)).toBe(true)
  expect(notResumed(new RunBusyError("/l"), false)).toBe(false)
})

test("only records an advance writes count as appended", async () => {
  const waiting = makeJob(base(), "flows/inbox.yaml", { inputs: {} })
  expect((await run(waiting, new Recorder())).outcome?.status).toBe("waiting")
  const quiet = inspectRun(waiting.log).lastSeq
  expect(quiet).not.toBeNull()
  const send = { id: "s1", op: "send", inbox: "messages", event: "hi" } as const
  const delivered = await run(advanceJob(waiting, { advance: false, deliver: [send] }), new Recorder())
  expect(delivered.outcome?.status).toBe("waiting")
  expect(inspectRun(waiting.log).lastSeq).toBeGreaterThan(quiet!)
  expect(advanceAppended(waiting.log, quiet)).toBe(false)

  const fake = await fakeLlm()
  const stopped = makeJob(base())
  await stoppedRun(fake, stopped)
  const before = inspectRun(stopped.log).lastSeq
  fake.script({ content: "Done." })
  expect((await run(advanceJob(stopped), new Recorder(), { env: fake.env() })).outcome?.status).toBe("succeeded")
  expect(advanceAppended(stopped.log, before)).toBe(true)

  expect(advanceAppended(waiting.log, null)).toBe(true)
})

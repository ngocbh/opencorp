/** Interrupts (a per-node signal, finished nodes and close), and steering through a run's steer inbox. */
import fs from "node:fs"
import { expect, setDefaultTimeout, test } from "bun:test"
import type { ScriptedReply } from "../../src/testing/fake_llm.ts"
import { Interrupts } from "../../src/worker/inbox.ts"
import type { Job, JobInput } from "../../src/worker/job.ts"
import { fakeLlm } from "../chat/helpers.ts"
import { waitFor } from "../helpers.ts"
import { base, inProcessWorker, makeJob, Recorder, run, type TestWorker } from "./helpers.ts"

setDefaultTimeout(30_000)

test("a finished node refuses interrupts", () => {
  const interrupts = new Interrupts()
  expect(interrupts.interrupt("reply") && interrupts.interruptSignal("reply").aborted).toBe(true)
  interrupts.finish("reply")
  expect(interrupts.interruptSignal("reply").aborted).toBe(false)
  expect(interrupts.interrupt("reply")).toBe(false)
})

test("close refuses new interrupts", () => {
  const interrupts = new Interrupts()
  const signal = interrupts.interruptSignal("loop#1/b")
  interrupts.close()
  expect(interrupts.interrupt("loop#1/b") || interrupts.interrupt("never-ran")).toBe(false)
  expect(signal.aborted).toBe(false)
})

test("an interrupt waits for its node to start", () => {
  const interrupts = new Interrupts()
  expect(interrupts.interrupt("later") && interrupts.interruptSignal("later").aborted).toBe(true)
})

test("a node is cut once it reads its interrupt", () => {
  const interrupts = new Interrupts()
  expect(interrupts.interrupt("reply") && !interrupts.cut("reply")).toBe(true)
  expect(interrupts.interruptSignal("reply").aborted && interrupts.cut("reply")).toBe(true)
  interrupts.finish("reply")
  expect(interrupts.cut("reply")).toBe(false)
})

test("an interrupt aborts the signal a running node already took", () => {
  const interrupts = new Interrupts()
  const signal = interrupts.interruptSignal("reply")
  expect(signal.aborted || interrupts.cut("reply")).toBe(false)
  expect(interrupts.interrupt("reply")).toBe(true)
  expect(signal.aborted && interrupts.cut("reply")).toBe(true)
})

test("after close a node gets a signal that never aborts", () => {
  const interrupts = new Interrupts()
  interrupts.close()
  expect(interrupts.interruptSignal("x").aborted || interrupts.interrupt("x")).toBe(false)
})

const TOOL_THEN_DONE: ScriptedReply[] = [
  { content: "Working", tool_calls: [{ name: "shout", arguments: { text: "hi" } }] },
  { content: "Done." },
]

/** Runs `shout`, and during the call steers or interrupts the running node; with `until`, the call returns once
 *  `until()` holds. */
class Steering extends Recorder {
  constructor(
    readonly action: (worker: TestWorker) => unknown,
    readonly until?: () => boolean,
  ) {
    super()
  }

  override async toolCall(
    worker: TestWorker,
    _group: string,
    _name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    // Not awaited: the office channel writes in call order, so the worker reads this frame before the reply and
    // the node sees it before the tool returns. A failed send shows in what the test checks, so it is not kept.
    Promise.resolve(this.action(worker)).catch(() => {})
    if (this.until) await waitFor(this.until, { timeout: 10_000, what: "the tool's condition" })
    return String(args.text).toUpperCase()
  }
}

function specGroups(): JobInput["groups"] {
  return {
    toolbox: [
      { name: "shout", parameters: { type: "object", required: ["text"], properties: { text: { type: "string" } } } },
    ],
  }
}

/** The payloads of `job`'s run log records of `kind`, in order. */
function logPayloads(job: Job, kind: string): Record<string, unknown>[] {
  return fs
    .readFileSync(job.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; payload: Record<string, unknown> })
    .filter((record) => record.kind === kind)
    .map((record) => record.payload)
}

/** The `steer` steps the run log of `job` records, as `[node id, step]`. */
function steerSteps(job: Job): [unknown, Record<string, unknown>][] {
  return logPayloads(job, "node_step")
    .map((payload) => [payload.node_id, payload.step as Record<string, unknown>] as [unknown, Record<string, unknown>])
    .filter(([, step]) => step.kind === "steer")
}

test("a steer reaches the next model call", async () => {
  const fake = await fakeLlm()
  fake.script(...TOOL_THEN_DONE)
  const handlers = new Steering((w) => w.steer("steers", "Also mention Rome."))
  const job = makeJob(base(), "flows/steerable.yaml", { groups: specGroups() })
  const rec = await run(job, handlers, { env: fake.env() })
  expect(rec.outcome?.output).toBe("Done.")
  expect(rec.left).toEqual([])
  expect(JSON.stringify(fake.requests()[1]!.messages)).toContain("Also mention Rome.")
  expect(steerSteps(job).map(([nodeId, step]) => [nodeId, step.inbox])).toEqual([["reply", "steers"]])
  const succeeded = rec.frames.filter((f) => f.name === "NodeSucceeded")
  expect(succeeded.every((f) => !Object.hasOwn(f.data as object, "interrupted"))).toBe(true)
})

test("an interrupt returns the text so far", async () => {
  const fake = await fakeLlm()
  fake.script(...TOOL_THEN_DONE)
  const job = makeJob(base(), "flows/steerable.yaml", { groups: specGroups() })
  const rec = await run(job, new Steering((w) => w.interrupt("reply")), { env: fake.env() })
  expect([rec.outcome?.status, rec.outcome?.output]).toEqual(["succeeded", "Working"])
  expect(fake.requests().length).toBe(1)
  const ended = rec.frames
    .filter((f) => f.name === "NodeSucceeded" && (f.data as Record<string, unknown>).node_id === "reply")
    .map((f) => f.data as Record<string, unknown>)
  expect(ended.length).toBe(1)
  expect(ended[0]!.interrupted).toBe(true)
})

test("a steer the node never reads stays in the inbox", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Done.", hold: true })
  const rec = new Recorder()
  const job = makeJob(base(), "flows/steerable.yaml", { groups: specGroups() })
  const worker = await inProcessWorker(job, rec, { env: fake.env() })
  await fake.waitForRequests(1, 30_000)
  expect(await worker.steer("steers", "late")).toBe(true)
  const sent = () => logPayloads(job, "pool_commit").some((payload) => payload.value === "late")
  await waitFor(sent, { timeout: 10_000, what: "the log to hold the send" })
  fake.release()
  expect(await worker.wait()).toBe(0)
  expect(rec.outcome?.output).toBe("Done.")
  expect(rec.left).toEqual([])
  expect(fake.requests().length).toBe(1)
  expect(steerSteps(job)).toEqual([])
})

test("a steer yian refuses comes back at once", async () => {
  const fake = await fakeLlm()
  fake.script(...TOOL_THEN_DONE)
  const refused = JSON.stringify([["nowhere", ["Hello?"]]])
  const handlers: Steering = new Steering(
    (w) => w.steer("nowhere", "Hello?"),
    () => JSON.stringify(handlers.left) === refused,
  )
  const job = makeJob(base(), "flows/steerable.yaml", { groups: specGroups() })
  const rec = await run(job, handlers, { env: fake.env() })
  expect(rec.outcome?.status).toBe("succeeded")
  expect(rec.left).toEqual([["nowhere", ["Hello?"]]])
  expect(rec.order).toEqual(["steer_left", "result"])
})

test("a steer sent as the run ends is applied or returned", async () => {
  const fake = await fakeLlm()
  fake.script(...TOOL_THEN_DONE)
  const handlers = new Steering(() => {})
  const job = makeJob(base(), "flows/steerable.yaml", { groups: specGroups() })
  const worker = await inProcessWorker(job, handlers, { env: fake.env() })
  const sent: string[] = []
  // steer() turns false once the office has read the result and closed its side (or the test end closed it).
  while (await worker.steer("steers", `<s${sent.length}>`)) {
    sent.push(`<s${sent.length}>`)
    await Bun.sleep(1)
  }
  expect(await worker.wait()).toBe(0)
  expect(handlers.outcome?.type).toBe("result")
  const applied = JSON.stringify(fake.requests().map((r) => r.messages))
  const committed = new Set(
    logPayloads(job, "pool_commit")
      .filter((payload) => payload.key === "__start__.steers")
      .map((payload) => payload.value),
  )
  const returned = handlers.left.flatMap(([, texts]) => texts)
  expect(sent.length).toBeGreaterThan(0)
  expect(returned.length).toBe(new Set(returned).size)
  // A refusal appends nothing, so a returned steer was never committed.
  expect(returned.filter((text) => committed.has(text))).toEqual([])
  const lost = sent.filter((text) => !applied.includes(text) && !committed.has(text) && !returned.includes(text))
  expect(lost).toEqual([])
})

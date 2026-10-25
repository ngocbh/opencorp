/** Deliveries: yian host calls a worker makes on its run, from the job and from deliver frames. */
import fs from "node:fs"
import path from "node:path"
import { foldRunLog, inspectRun, PoolCommitRecord } from "@ngocbh/yian/run"
import { pending } from "@ngocbh/yian/tools"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { type FakeLLM, LLM_CONFIG, type ScriptedReply } from "../../src/testing/fake_llm.ts"
import { ChannelClosed, type Frame } from "../../src/worker/channel.ts"
import { Job, type JobInput } from "../../src/worker/job.ts"
import { EXIT_FAILED, EXIT_OK } from "../../src/worker/main.ts"
import type { AskRequest } from "../../src/worker/rpc.ts"
import { fakeLlm } from "../chat/helpers.ts"
import { tempDir, waitFor } from "../helpers.ts"
import {
  base,
  inProcessWorker,
  lastFrame,
  makeJob,
  makeRegistry,
  Recorder,
  recordFrames,
  run,
  startWorker,
  type TestWorker,
} from "./helpers.ts"

setDefaultTimeout(30_000)

const TOOL_THEN_DONE: ScriptedReply[] = [
  { content: "Working", tool_calls: [{ name: "shout", arguments: { text: "hi" } }] },
  { content: "Done." },
]

/** Runs `shout`, and during the call acts on the worker; with `until`, the call returns once `until()` holds. */
class DuringShout extends Recorder {
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

/** The values the run log of `job` commits to the flow input `inbox`, in order. */
function sent(job: Job, inbox: string): unknown[] {
  return logPayloads(job, "pool_commit")
    .filter((payload) => payload.key === `__start__.${inbox}`)
    .map((payload) => payload.value)
}

/** The `steer` steps the run log of `job` records, as `[node id, step]`. */
function steerSteps(job: Job): [unknown, Record<string, unknown>][] {
  return logPayloads(job, "node_step")
    .map((payload) => [payload.node_id, payload.step as Record<string, unknown>] as [unknown, Record<string, unknown>])
    .filter(([, step]) => step.kind === "steer")
}

/** A `Recorder` that also notes, for each `deliver_reply`, whether the RunStarted event came before it. */
class RepliesAfterStart extends Recorder {
  readonly afterStart: boolean[] = []

  override deliverReply(worker: unknown, frame: Frame): void {
    this.afterStart.push(this.names().includes("RunStarted"))
    super.deliverReply(worker, frame)
  }
}

/** Reads `office`'s frames until `done(frames)` holds; returns every frame read. */
async function readUntil(office: { recv(): Promise<Frame> }, done: (frames: Frame[]) => boolean): Promise<Frame[]> {
  const frames: Frame[] = []
  while (!done(frames)) frames.push(await office.recv())
  return frames
}

test("a steer reaches the next model call", async () => {
  const fake = await fakeLlm()
  fake.script(...TOOL_THEN_DONE)
  const steer = { id: "d1", op: "send", inbox: "steers", event: "Also mention Rome." } as const
  const handlers = new DuringShout((w) => w.deliver(steer))
  const job = makeJob(base(), "flows/steerable.yaml", { groups: specGroups() })
  const rec = await run(job, handlers, { env: fake.env() })
  expect(rec.outcome?.output).toBe("Done.")
  expect(JSON.stringify(fake.requests()[1]!.messages)).toContain("Also mention Rome.")
  expect(steerSteps(job).map(([nodeId, step]) => [nodeId, step.inbox])).toEqual([["reply", "steers"]])
  const succeeded = rec.frames.filter((f) => f.name === "NodeSucceeded")
  expect(succeeded.length).toBeGreaterThan(0)
  expect(succeeded.every((f) => (f.data as Record<string, unknown>).interrupted === false)).toBe(true)
  expect(rec.replies).toEqual([{ type: "deliver_reply", id: "d1", seq: expect.any(Number) }])
})

test("an interrupt returns the text so far", async () => {
  const fake = await fakeLlm()
  fake.script(...TOOL_THEN_DONE)
  const job = makeJob(base(), "flows/cuttable.yaml", { groups: specGroups() })
  const env = fake.env()
  const rec = await run(job, new DuringShout((w) => w.deliver({ id: "i1", op: "interrupt", inbox: "steers" })), {
    env,
  })
  expect([rec.outcome?.status, rec.outcome?.output]).toEqual(["succeeded", null])
  expect(fake.requests().length).toBe(1)
  const ended = rec.frames
    .filter((f) => f.name === "NodeSucceeded" && (f.data as Record<string, unknown>).node_id === "reply")
    .map((f) => f.data as Record<string, unknown>)
  expect(ended.length).toBe(1)
  expect(ended[0]!.interrupted).toBe(true)
  expect(rec.replies).toEqual([{ type: "deliver_reply", id: "i1", seq: null, closed: [] }])
  const folded = await foldRunLog(job.log, { env: (name) => env[name], codeRoot: job.pin })
  const newMessages = folded.records.find(
    ({ entry, value }) =>
      value !== null &&
      entry.envelope.record instanceof PoolCommitRecord &&
      entry.envelope.record.key === "reply.new_messages",
  )
  expect(newMessages).toBeDefined()
  const [cut] = newMessages!.value!.toObject() as Record<string, unknown>[]
  expect(cut).toMatchObject({
    role: "assistant",
    parts: [
      { type: "text", text: "Working" },
      { type: "tool_call", name: "shout" },
    ],
  })
})

test("a steer the node never reads stays in the inbox", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Done.", hold: true })
  const rec = new Recorder()
  const job = makeJob(base(), "flows/steerable.yaml", { groups: specGroups() })
  // One model call at most: without the cap, a steer queued at the final answer is read and answered.
  const env = { ...fake.env(), YIAN_AGENT_MAX_TOOL_ITERATIONS: "1" }
  const worker = await inProcessWorker(job, rec, { env })
  await fake.waitForRequests(1, 30_000)
  expect(await worker.deliver({ id: "late", op: "send", inbox: "steers", event: "late" })).toBe(true)
  await waitFor(() => sent(job, "steers").includes("late"), { timeout: 10_000, what: "the log to hold the send" })
  fake.release()
  expect(await worker.wait()).toBe(0)
  expect(rec.outcome?.output).toBe("Done.")
  expect(rec.replies).toEqual([{ type: "deliver_reply", id: "late", seq: expect.any(Number) }])
  expect(fake.requests().length).toBe(1)
  expect(steerSteps(job)).toEqual([])
})

test("a steer yian refuses is refused at once", async () => {
  const fake = await fakeLlm()
  fake.script(...TOOL_THEN_DONE)
  const handlers: DuringShout = new DuringShout(
    (w) => w.deliver({ id: "n1", op: "send", inbox: "nowhere", event: "Hello?" }),
    () => handlers.replies.length === 1,
  )
  const job = makeJob(base(), "flows/steerable.yaml", { groups: specGroups() })
  const rec = await run(job, handlers, { env: fake.env() })
  expect(rec.outcome?.status).toBe("succeeded")
  expect(rec.replies).toEqual([{ type: "deliver_reply", id: "n1", refused: "unknown_inbox" }])
  expect(rec.order).toEqual(["deliver_reply", "result"])
})

test("a steer sent as the run ends is applied or refused", async () => {
  const fake = await fakeLlm()
  fake.script(...TOOL_THEN_DONE)
  const handlers = new DuringShout(() => {})
  const job = makeJob(base(), "flows/steerable.yaml", { groups: specGroups() })
  const worker = await inProcessWorker(job, handlers, { env: fake.env() })
  const ids: string[] = []
  // deliver() turns false once the office has read the result and closed its side (or the test end closed it).
  while (await worker.deliver({ id: `d${ids.length}`, op: "send", inbox: "steers", event: `<s${ids.length}>` })) {
    ids.push(`d${ids.length}`)
    await Bun.sleep(1)
  }
  expect(await worker.wait()).toBe(0)
  expect(handlers.outcome?.type).toBe("result")
  expect(ids.length).toBeGreaterThan(0)
  expect(handlers.replies.map((reply) => reply.id).sort()).toEqual([...ids].sort())
  const text = (id: unknown) => `<s${String(id).slice(1)}>`
  const applied = JSON.stringify(fake.requests().map((r) => r.messages))
  const committed = new Set(sent(job, "steers"))
  const refused = handlers.replies.filter((reply) => Object.hasOwn(reply, "refused"))
  expect(refused.every((reply) => reply.refused === "ended")).toBe(true)
  // A refusal appends nothing, so a refused send was never committed.
  expect(refused.filter((reply) => committed.has(text(reply.id)))).toEqual([])
  const refusedIds = new Set(refused.map((reply) => reply.id))
  const lost = ids.filter((id) => !applied.includes(text(id)) && !committed.has(text(id)) && !refusedIds.has(id))
  expect(lost).toEqual([])
})

test("deliveries sent before RunStarted arrive in order", async () => {
  const fake = await fakeLlm()
  onTestFinished(() => fake.release())
  fake.script({ content: "Done.", hold: true }, { content: "Done." })
  const rec = new RepliesAfterStart()
  const job = makeJob(base(), "flows/steerable.yaml", {
    groups: specGroups(),
    deliver: [
      { id: "a", op: "send", inbox: "steers", event: "a" },
      { id: "b", op: "send", inbox: "steers", event: "b" },
    ],
  })
  const worker = await inProcessWorker(job, rec, { env: fake.env() })
  // The job's a and b are always held: they are queued before the run starts. Whether the worker reads c and d
  // before RunStarted (held) or after (applied live) is a race the test can't control; either way they follow a and
  // b, and no reply comes before the run started.
  expect(await worker.deliver({ id: "c", op: "send", inbox: "steers", event: "c" })).toBe(true)
  expect(await worker.deliver({ id: "d", op: "send", inbox: "steers", event: "d" })).toBe(true)
  await fake.waitForRequests(1, 30_000)
  await waitFor(() => rec.replies.length === 4, { timeout: 10_000, what: "the four replies" })
  fake.release()
  expect(await worker.wait()).toBe(0)
  expect(rec.outcome?.status).toBe("succeeded")
  expect(sent(job, "steers")).toEqual(["a", "b", "c", "d"])
  expect(rec.replies.map((reply) => reply.id)).toEqual(["a", "b", "c", "d"])
  expect(rec.afterStart).toEqual([true, true, true, true])
  const seqs = rec.replies.map((reply) => reply.seq as number)
  expect(seqs.every((seq, i) => typeof seq === "number" && (i === 0 || seq > seqs[i - 1]!))).toBe(true)
})

test("a runFlow that throws first refuses the buffered deliveries", async () => {
  const fake = await fakeLlm()
  const rec = new Recorder()
  const job = makeJob(base(), "flows/echo.yaml", {
    inputs: { message: "hi", nope: 1 },
    deliver: [{ id: "a", op: "send", inbox: "steers", event: "a" }],
  })
  const worker = await inProcessWorker(job, rec, { env: fake.env() })
  expect(await worker.deliver({ id: "b", op: "send", inbox: "steers", event: "b" })).toBe(true)
  expect(await worker.wait()).toBe(EXIT_FAILED)
  expect(rec.outcome?.type).toBe("error")
  expect([...rec.replies].sort((x, y) => String(x.id).localeCompare(String(y.id)))).toEqual([
    { type: "deliver_reply", id: "a", refused: "not_started" },
    { type: "deliver_reply", id: "b", refused: "not_started" },
  ])
  expect(rec.replies[0]!.id).toBe("a")
  expect([
    ["deliver_reply", "deliver_reply", "error"],
    ["deliver_reply", "error", "deliver_reply"],
  ]).toContainEqual(rec.order)
  expect(fs.existsSync(job.log)).toBe(false)
  expect(fake.requests()).toEqual([])
})

test("a delivery during the linger is acked", async () => {
  const job = makeJob(base(), "flows/inbox.yaml", { inputs: {} })
  const { office, done, out } = await startWorker()
  await office.send({ type: "start", job })
  const result = await lastFrame(office)
  expect(result.type, String(result.message)).toBe("result")
  expect(result.status).toBe("waiting")
  expect(result.waits).toEqual([expect.objectContaining({ tool: "take", inbox: "messages", settled: false })])
  await office.send({ type: "deliver", id: "late", op: "send", inbox: "messages", event: "hi" })
  expect(await office.recv()).toEqual({ type: "deliver_reply", id: "late", seq: expect.any(Number) })
  office.closeSend()
  await done
  expect(out.code).toBe(EXIT_OK)
  expect(sent(job, "messages")).toEqual(["hi"])
})

test("a delivery the ended loop could not read shows as a settled wait", async () => {
  const job = makeJob(base(), "flows/inbox.yaml", { inputs: {} })
  const { office } = await startWorker()
  await office.send({ type: "start", job })
  let delivered = false
  const frames = await readUntil(office, (read) => {
    const last = read.at(-1)
    // Sent as soon as the RunWaiting event is read, while the run call is finishing.
    if (!delivered && last?.type === "event" && last.name === "RunWaiting") {
      delivered = true
      void office.send({ type: "deliver", id: "w1", op: "send", inbox: "messages", event: "hi" })
    }
    return read.some((f) => f.type === "result") && read.some((f) => f.type === "deliver_reply")
  })
  const resultAt = frames.findIndex((f) => f.type === "result")
  const replyAt = frames.findIndex((f) => f.type === "deliver_reply")
  expect(frames[replyAt]).toEqual({ type: "deliver_reply", id: "w1", seq: expect.any(Number) })
  expect(sent(job, "messages")).toEqual(["hi"])
  const result = frames[resultAt]!
  if (replyAt < resultAt) expect((result.waits as Record<string, unknown>[])[0]!.settled).toBe(true)
})

test("a deliver to a run that ended is refused", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Done." })
  const job = makeJob(base(), "flows/steerable.yaml", { groups: specGroups() })
  const { office } = await startWorker({ env: fake.env() })
  await office.send({ type: "start", job })
  const result = await lastFrame(office)
  expect([result.type, result.status]).toEqual(["result", "succeeded"])
  await office.send({ type: "deliver", id: "e1", op: "send", inbox: "steers", event: "too late" })
  expect(await office.recv()).toEqual({ type: "deliver_reply", id: "e1", refused: "ended" })
})

test("a malformed deliver frame after the result is a bad office frame", async () => {
  const job = makeJob(base(), "flows/inbox.yaml", { inputs: {} })
  const { office, done, out } = await startWorker({ linger: 60_000 })
  await office.send({ type: "start", job })
  expect((await lastFrame(office)).status).toBe("waiting")
  const began = performance.now()
  await office.send({ type: "deliver", id: "x", op: "send" })
  await office.send({ type: "deliver", id: "y", op: "send", inbox: "messages", event: "hi" })
  await done
  // Reading ended, so the linger ended at once, not after its 60 s.
  expect(performance.now() - began).toBeLessThan(4000)
  expect(out.code).toBe(EXIT_OK)
  expect(out.exit).toBeUndefined()
  await expect(office.recv()).rejects.toBeInstanceOf(ChannelClosed)
  expect(sent(job, "messages")).toEqual([])
})

test("a refused delivery reply holds only the reason", async () => {
  const job = makeJob(base(), "flows/inbox.yaml", { inputs: {} })
  const { office } = await startWorker()
  await office.send({ type: "start", job })
  expect((await lastFrame(office)).status).toBe("waiting")
  await office.send({ type: "deliver", id: "c1", op: "complete", call_id: "nope", result: { output: "sk-SECRET" } })
  expect(await office.recv()).toEqual({ type: "deliver_reply", id: "c1", refused: "unknown_call" })
})

/** An advance job of the run `chat` started: same run, log, pin, grants and model config; `over` replaces fields. */
function advanceJob(chat: Job, over: Partial<JobInput> = {}): Job {
  return Job.parse({ ...chat, kind: "advance", deliver: [], ...over })
}

/** A `Recorder` that also lists, in arrival order, the RunResumed event and each reply's id. */
class ResumeOrder extends Recorder {
  readonly seen: string[] = []

  override event(worker: unknown, frame: Frame): void {
    if (frame.name === "RunResumed") this.seen.push("RunResumed")
    super.event(worker, frame)
  }

  override deliverReply(worker: unknown, frame: Frame): void {
    this.seen.push(String(frame.id))
    super.deliverReply(worker, frame)
  }
}

/** The data of each `NodeSucceeded` event `rec` recorded for the node `reply`. */
function replyEnded(rec: Recorder): Record<string, unknown>[] {
  return rec.frames
    .filter((f) => f.name === "NodeSucceeded" && (f.data as Record<string, unknown>).node_id === "reply")
    .map((f) => f.data as Record<string, unknown>)
}

/** Starts a chat job on the cuttable flow in a worker process and kills it while its model call is held; returns
 *  the job, whose run is then crashed. */
async function crashedRun(fake: FakeLLM): Promise<Job> {
  const where = base()
  const job = makeJob(where, "flows/cuttable.yaml", { groups: specGroups() })
  fake.script({ content: "lost", hold: true })
  const sessionDir = path.join(where.root, "sessions", "s1")
  const worker = await makeRegistry().spawn(job, sessionDir, new Recorder(), { env: fake.env() })
  await fake.waitForRequests(1, 30_000)
  worker.kill()
  expect(await worker.wait(10_000)).toBe(-9)
  expect(inspectRun(job.log).status).toBe("crashed")
  return job
}

test("an advance job applies its sends then moves the run", async () => {
  const chat = makeJob(base(), "flows/inbox.yaml", { inputs: {} })
  expect((await run(chat, new Recorder())).outcome?.status).toBe("waiting")
  const send = { id: "s1", op: "send", inbox: "messages", event: "hi" } as const
  const rec = await run(advanceJob(chat, { deliver: [send] }), new Recorder())
  expect(rec.outcome?.status, String(rec.outcome?.message)).toBe("succeeded")
  expect((rec.outcome?.output as { events: unknown[] }).events).toEqual(["hi"])
  expect(rec.replies).toEqual([{ type: "deliver_reply", id: "s1", seq: expect.any(Number) }])
  expect(rec.order).toEqual(["deliver_reply", "result"])
})

test("an advance job with advance false only delivers", async () => {
  const chat = makeJob(base(), "flows/inbox.yaml", { inputs: {} })
  expect((await run(chat, new Recorder())).outcome?.status).toBe("waiting")
  const send = { id: "s1", op: "send", inbox: "messages", event: "hi" } as const
  const rec = await run(advanceJob(chat, { advance: false, deliver: [send] }), new Recorder())
  expect(rec.outcome).toMatchObject({ type: "result", status: "waiting", run_id: "r1", output: null, failure: null })
  expect((rec.outcome?.waits as Record<string, unknown>[])[0]!.settled).toBe(true)
  expect(rec.order).toEqual(["deliver_reply", "result"])
  expect(sent(chat, "messages")).toEqual(["hi"])
  expect(logPayloads(chat, "node_woken")).toEqual([])
})

test("an interrupt for a crashed run takes effect after RunResumed", async () => {
  const fake = await fakeLlm()
  onTestFinished(() => fake.release())
  const chat = await crashedRun(fake)
  fake.script({ content: "late", hold: true })
  const rec = new ResumeOrder()
  const job = advanceJob(chat, { deliver: [{ id: "i1", op: "interrupt", inbox: "steers" }] })
  const worker = await inProcessWorker(job, rec, { env: fake.env() })
  expect(await worker.wait()).toBe(EXIT_OK)
  expect(rec.seen).toEqual(["RunResumed", "i1"])
  expect([rec.outcome?.status, rec.outcome?.output]).toEqual(["succeeded", null])
  expect(replyEnded(rec).map((data) => data.interrupted)).toEqual([true])
})

test("an interrupt frame for a crashed run waits for RunResumed", async () => {
  const fake = await fakeLlm()
  onTestFinished(() => fake.release())
  const chat = await crashedRun(fake)
  fake.script({ content: "late", hold: true })
  const rec = new ResumeOrder()
  // The worker reads the frame while the job's send applies offline; it stays held until RunResumed instead of
  // following the send straight away.
  const job = advanceJob(chat, { deliver: [{ id: "s1", op: "send", inbox: "steers", event: "x" }] })
  const worker = await inProcessWorker(job, rec, {
    env: fake.env(),
    early: [{ id: "i1", op: "interrupt", inbox: "steers" }],
  })
  expect(await worker.wait()).toBe(EXIT_OK)
  expect(rec.seen).toEqual(["s1", "RunResumed", "i1"])
  expect([rec.outcome?.status, rec.outcome?.output]).toEqual(["succeeded", null])
  expect(replyEnded(rec).map((data) => data.interrupted)).toEqual([true])
})

test("a stopped run takes its sends before the advance and its close after RunResumed", async () => {
  const fake = await fakeLlm()
  onTestFinished(() => fake.release())
  fake.script({ content: "lost", hold: true })
  const chat = makeJob(base(), "flows/cuttable.yaml", { groups: specGroups() })
  const first = await inProcessWorker(chat, new Recorder(), { env: fake.env() })
  await fake.waitForRequests(1, 30_000)
  expect(await first.stop()).toBe(true)
  expect(await first.wait()).toBe(EXIT_FAILED)
  expect(inspectRun(chat.log).status).toBe("stopped")
  fake.script({ content: "Done." })
  const rec = new ResumeOrder()
  const job = advanceJob(chat, {
    deliver: [
      { id: "s1", op: "send", inbox: "steers", event: "more" },
      { id: "c1", op: "close", inbox: "steers" },
    ],
  })
  const worker = await inProcessWorker(job, rec, { env: fake.env() })
  expect(await worker.wait()).toBe(EXIT_OK)
  expect(rec.seen).toEqual(["s1", "RunResumed", "c1"])
  expect(rec.replies).toEqual([
    { type: "deliver_reply", id: "s1", seq: expect.any(Number) },
    { type: "deliver_reply", id: "c1", seq: expect.any(Number) },
  ])
  expect([rec.outcome?.status, rec.outcome?.output]).toEqual(["succeeded", "Done."])
  expect(JSON.stringify(fake.requests().at(-1)!.messages)).toContain("more")
})

test("an advance that throws before its gate opens refuses the held deliveries", async () => {
  const fake = await fakeLlm()
  onTestFinished(() => fake.release())
  fake.script({ content: "Done.", hold: true })
  const chat = makeJob(base(), "flows/cuttable.yaml", { groups: specGroups() })
  const first = new Recorder()
  const a = await inProcessWorker(chat, first, { env: fake.env() })
  await fake.waitForRequests(1, 30_000)
  const rec = new Recorder()
  const job = advanceJob(chat, { deliver: [{ id: "i1", op: "interrupt", inbox: "steers" }] })
  const b = await inProcessWorker(job, rec, { env: fake.env() })
  expect(await b.wait()).toBe(EXIT_FAILED)
  expect(rec.replies).toEqual([{ type: "deliver_reply", id: "i1", refused: "not_started" }])
  expect(rec.order).toEqual(["deliver_reply", "error"])
  expect(String(rec.outcome?.message)).toStartWith("RunBusyError:")
  fake.release()
  expect(await a.wait()).toBe(EXIT_OK)
  expect([first.outcome?.status, first.outcome?.output]).toEqual(["succeeded", "Done."])
  expect(replyEnded(first).map((data) => data.interrupted)).toEqual([false])
})

test("an advance false job on a running run refuses its deliveries", async () => {
  const fake = await fakeLlm()
  onTestFinished(() => fake.release())
  fake.script({ content: "Done.", hold: true })
  const chat = makeJob(base(), "flows/cuttable.yaml", { groups: specGroups() })
  const first = new Recorder()
  const a = await inProcessWorker(chat, first, { env: fake.env() })
  await fake.waitForRequests(1, 30_000)
  const rec = new Recorder()
  const job = advanceJob(chat, { advance: false, deliver: [{ id: "s1", op: "send", inbox: "steers", event: "x" }] })
  const b = await inProcessWorker(job, rec, { env: fake.env() })
  expect(await b.wait()).toBe(EXIT_FAILED)
  expect(rec.replies).toEqual([{ type: "deliver_reply", id: "s1", refused: "not_started" }])
  expect(rec.order).toEqual(["deliver_reply", "error"])
  expect(String(rec.outcome?.message)).toStartWith("RunBusyError:")
  fake.release()
  expect(await a.wait()).toBe(EXIT_OK)
  expect(first.outcome?.status).toBe("succeeded")
  expect(sent(chat, "steers")).toEqual([])
})

test("an advance confines the recorded flow to the pin", async () => {
  const chat = makeJob(base(), "flows/coded.yaml", { inputs: {} })
  const started = await run(chat, new Recorder())
  expect(started.outcome?.status, String(started.outcome?.message)).toBe("waiting")
  const send = { id: "s1", op: "send", inbox: "messages", event: "hi" } as const
  const rec = await run(advanceJob(chat, { pin: tempDir(), deliver: [send] }), new Recorder())
  expect(rec.replies).toEqual([{ type: "deliver_reply", id: "s1", failed: "LoadError" }])
  expect(rec.order).toEqual(["deliver_reply", "error"])
  expect(String(rec.outcome?.message)).toStartWith("LoadError:")
  expect(sent(chat, "messages")).toEqual([])
})

test("an advance job sends the key only to the model", async () => {
  const fake = await fakeLlm()
  const key = "sk-ADV-1"
  const frames = recordFrames()
  const llm_config = { ...LLM_CONFIG, base_url: `${fake.baseUrl}/v1`, api_key: key }
  const chat = makeJob(base(), "flows/heard.yaml", { inputs: {}, llm_config })
  expect((await run(chat, new Recorder(), { env: {} })).outcome?.status).toBe("waiting")
  fake.script({ content: "ok" })
  const send = { id: "s1", op: "send", inbox: "messages", event: "hi" } as const
  const rec = await run(advanceJob(chat, { deliver: [send] }), new Recorder(), { env: {} })
  expect([rec.outcome?.status, rec.outcome?.output]).toEqual(["succeeded", "ok"])
  expect(fake.authorizations()).toEqual([`Bearer ${key}`])
  // In process, each start frame is recorded twice: as the office sends it and as the worker reads it.
  const holding = frames.filter((frame) => frame.includes(key)).map((frame) => JSON.parse(frame).type)
  expect(holding).toEqual(["start", "start", "start", "start"])
  expect(fs.readFileSync(chat.log, "utf8")).not.toContain(key)
})

/** A `Recorder` whose questions all answer later: it records each and returns yian's pending marker. */
class Pending extends Recorder {
  override askUser(_worker: unknown, request: AskRequest): unknown {
    this.asked.push(request)
    return pending()
  }
}

test("one advance job with send and complete deliveries runs a turn", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Off we go." })
  const chat = makeJob(base(), "flows/turn.yaml", { inputs: {} })
  const asking = await run(chat, new Pending(), { env: fake.env() })
  expect(asking.outcome?.status, String(asking.outcome?.message)).toBe("waiting")
  expect(asking.asked.map((request) => [request.question, request.node_id])).toEqual([["Where to?", "asked"]])
  const waits = asking.outcome?.waits as Record<string, unknown>[]
  expect(waits.map((wait) => [wait.node, wait.tool]).sort()).toEqual([
    ["asked", "ask"],
    ["heard", "take"],
  ])
  const ask = waits.find((wait) => wait.tool === "ask")!
  const rec = await run(
    advanceJob(chat, {
      deliver: [
        { id: "s1", op: "send", inbox: "messages", event: "to Rome" },
        { id: "c1", op: "complete", call_id: String(ask.call_id), result: { output: "Paris" } },
      ],
    }),
    new Recorder(),
    { env: fake.env() },
  )
  expect([rec.outcome?.status, rec.outcome?.output], String(rec.outcome?.message)).toEqual(["succeeded", "Off we go."])
  expect(rec.replies).toEqual([
    { type: "deliver_reply", id: "s1", seq: expect.any(Number) },
    { type: "deliver_reply", id: "c1", seq: expect.any(Number) },
  ])
  expect(fake.requests()).toHaveLength(1)
  const request = JSON.stringify(fake.requests()[0]!.messages)
  expect(request).toContain("to Rome")
  expect(request).toContain("Paris")
})

test("an offline interrupt reply lists the closed calls", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "", tool_calls: [{ name: "ask_user", arguments: { question: "Which city?" } }] })
  const chat = makeJob(base(), "flows/ask_cut.yaml")
  const asking = await run(chat, new Pending(), { env: fake.env() })
  expect(asking.outcome?.status, String(asking.outcome?.message)).toBe("waiting")
  expect(asking.asked.map((request) => request.question)).toEqual(["Which city?"])
  const waits = asking.outcome?.waits as Record<string, unknown>[]
  expect(waits).toEqual([expect.objectContaining({ node: "reply", tool: "ask_user", settled: false })])
  const job = advanceJob(chat, { deliver: [{ id: "i1", op: "interrupt", inbox: "steers" }] })
  const rec = await run(job, new Recorder(), { env: fake.env() })
  expect(rec.replies).toEqual([{ type: "deliver_reply", id: "i1", seq: null, closed: [waits[0]!.call_id] }])
  expect([rec.outcome?.status, rec.outcome?.output], String(rec.outcome?.message)).toEqual(["succeeded", null])
  expect(fake.requests()).toHaveLength(1)
})

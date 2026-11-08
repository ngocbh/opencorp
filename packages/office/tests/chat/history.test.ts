/** Seeding a fresh chat run from the run it replaces. */
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { foldRunLog, inspectRun, PoolCommitRecord } from "@ngocbh/yian/run"
import type { FakeLLM } from "../../src/testing/fake_llm.ts"
import type { Frame } from "../../src/worker/channel.ts"
import type { Job } from "../../src/worker/job.ts"
import { captureStderr, tempDir, waitFor } from "../helpers.ts"
import {
  advanceJob,
  base,
  CODED,
  CODED_HELPERS,
  inProcessWorker,
  makeJob,
  makeRegistry,
  Recorder,
  run,
  runWorker,
  type TestWorker,
  writeFiles,
} from "../worker/helpers.ts"
import {
  CHAT_FILES,
  EMPTY,
  fakeLlm,
  message,
  nextRun,
  send,
  TemplateOffice,
  templateJob,
  waitingAt,
  waitingChat,
} from "./helpers.ts"

setDefaultTimeout(30_000)

/** Keeps the lines of `log` up to and including the first one `match` accepts. */
function cutAfter(log: string, match: (line: string) => boolean): void {
  const lines = fs.readFileSync(log, "utf8").split("\n")
  const at = lines.findIndex(match)
  expect(at).toBeGreaterThanOrEqual(0)
  fs.writeFileSync(log, `${lines.slice(0, at + 1).join("\n")}\n`)
}

/** The START inputs of the run `job` started, read from its log. */
async function startInputs(job: Job, fake: FakeLLM): Promise<Record<string, unknown>> {
  const { records } = await foldRunLog(job.log, { env: (name) => fake.env()[name], codeRoot: job.pin })
  const start = records.find(
    ({ entry, value }) =>
      value !== null && entry.envelope.record instanceof PoolCommitRecord && entry.envelope.record.key === "__start__",
  )
  return start!.value!.toObject() as Record<string, unknown>
}

/** The seed naming the run `job` started, with the fake's env. */
function seedOf(job: Job, fake: FakeLLM, cancel = true) {
  return { log: job.log, env: fake.env(), cancel }
}

/** The texts of the user messages in the `index`th model request. */
function userTexts(fake: FakeLLM, index: number): unknown[] {
  return (fake.requests()[index]!.messages as Record<string, unknown>[])
    .filter((m) => m.role === "user")
    .map((m) => m.content)
}

/** The data of each `history_not_seeded` event `rec` recorded. */
function notSeeded(rec: Recorder): unknown[] {
  return rec.frames
    .filter((frame) => frame.type === "event" && frame.name === "history_not_seeded")
    .map((frame) => frame.data)
}

/** The `steer` steps the run log of `job` records. */
function steerSteps(job: Job): Record<string, unknown>[] {
  return fs
    .readFileSync(job.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; payload: { step?: Record<string, unknown> } })
    .filter((record) => record.kind === "node_step" && record.payload.step?.kind === "steer")
    .map((record) => record.payload.step!)
}

/** A pin holding the template chat flow and the worker tests' CODED flow beside its helper file. */
function codedPin(): { pin: string; runs: string } {
  const root = tempDir()
  const pin = writeFiles(path.join(root, "pin"), {
    ...CHAT_FILES,
    "flows/coded.yaml": CODED,
    "flows/helpers.ts": CODED_HELPERS,
  })
  return { pin, runs: path.join(root, "runs") }
}

test("the seeded summary reaches the fresh runs reply", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "ok" }, { content: "ok" })
  const first = new TemplateOffice()
  const r1 = templateJob("chat", first, { summary: "SUMMARY-7" }, { deliver: [send("n1", "hi")] })
  expect((await run(r1, first, { env: fake.env() })).outcome?.status).toBe("waiting")
  // An empty summary input, so only the seed can bring SUMMARY-7 back.
  const r2 = nextRun(r1, {
    inputs: { ...r1.inputs, summary: "" },
    seed: seedOf(r1, fake),
    deliver: [send("n1", "next")],
  })
  expect((await run(r2, new TemplateOffice(), { env: fake.env() })).outcome?.status).toBe("waiting")
  const system = (fake.requests()[1]!.messages as Record<string, unknown>[])[0]!
  expect(system.role).toBe("system")
  expect(String(system.content)).toContain("SUMMARY-7")
})

test("an orphan turn end is skipped", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "ok" }, { content: "ok" }, { content: "ok" })
  const first = new TemplateOffice()
  const r1 = templateJob("chat", first, {}, { deliver: [send("n1", "one")] })
  expect((await run(r1, first, { env: fake.env() })).outcome?.status).toBe("waiting")
  const second = await run(advanceJob(r1, { deliver: [send("n2", "two")] }), new TemplateOffice(), { env: fake.env() })
  expect(second.outcome?.waits).toMatchObject([{ node: "chat#2/heard" }])
  // A crash right after the second turn's end commit leaves it with no success naming it.
  cutAfter(r1.log, (line) => line.includes('"pool_commit"') && line.includes('"chat#1/__end__"'))
  const r2 = nextRun(r1, { seed: seedOf(r1, fake, false), deliver: [send("n1", "next")] })
  expect((await run(r2, new TemplateOffice(), { env: fake.env() })).outcome?.status).toBe("waiting")
  expect(userTexts(fake, 2)).toEqual(["one", "next"])
})

test("a run that finished no turn passes on its own history input", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "ok" })
  const first = new TemplateOffice()
  const r1 = templateJob("chat", first, { history: [[message("old words")]] })
  expect((await run(r1, first, { env: fake.env() })).outcome?.waits).toMatchObject([{ node: "chat#0/heard" }])
  // An empty history input, so only the seed can bring the old words back.
  const r2 = nextRun(r1, {
    inputs: { ...r1.inputs, history: [] },
    seed: seedOf(r1, fake),
    deliver: [send("n1", "next")],
  })
  expect((await run(r2, new TemplateOffice(), { env: fake.env() })).outcome?.status).toBe("waiting")
  expect(userTexts(fake, 0)).toEqual(["old words", "next"])
})

test("a trailing empty turn is dropped", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "ok" })
  const first = new TemplateOffice()
  const r1 = templateJob("chat", first, {}, { deliver: [send("n1", "hi")] })
  expect((await run(r1, first, { env: fake.env() })).outcome?.status).toBe("waiting")
  const close = advanceJob(r1, { deliver: [{ id: "close", op: "close", inbox: "messages" }] })
  const closed = await run(close, new TemplateOffice(), { env: fake.env() })
  expect(closed.outcome?.status).toBe("succeeded")
  const r2 = nextRun(r1, { seed: seedOf(r1, fake) })
  expect((await run(r2, new TemplateOffice(), { env: fake.env() })).outcome?.status).toBe("waiting")
  expect((await startInputs(r2, fake)).history).toHaveLength(1)
})

test("a history that is not a conversation seeds nothing", async () => {
  const fake = await fakeLlm()
  const unanswered = {
    role: "assistant",
    parts: [{ type: "tool_call", id: "call-1", name: "toolbox_stub", arguments: {} }],
  }
  const first = new TemplateOffice()
  const r1 = templateJob("chat", first, { history: [[unanswered]] })
  expect((await run(r1, first, { env: fake.env() })).outcome?.waits).toMatchObject([{ node: "chat#0/heard" }])
  const r2 = nextRun(r1, { seed: seedOf(r1, fake) })
  const rec = await run(r2, new TemplateOffice(), { env: fake.env() })
  expect(rec.outcome?.status).toBe("waiting")
  expect(notSeeded(rec)).toEqual([{ error_type: "ConversationError" }])
  const inputs = await startInputs(r2, fake)
  expect([inputs.history, inputs.summary]).toEqual([[], ""])
  expect(fake.requests()).toEqual([])
})

test("a replaced run whose code file is gone seeds an empty history", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "ok" })
  const where = codedPin()
  const r1 = makeJob(where, "flows/coded.yaml", { inputs: {} })
  expect((await run(r1, new Recorder(), { env: fake.env() })).outcome?.status).toBe("waiting")
  fs.rmSync(path.join(where.pin, "flows", "helpers.ts"))
  const office = new TemplateOffice()
  const r2 = templateJob("chat", office, {}, {
    base: where,
    run_id: "r2",
    seed: seedOf(r1, fake, false),
    deliver: [send("n1", "next")],
  })
  const rec = await run(r2, office, { env: fake.env() })
  expect(notSeeded(rec)).toEqual([{ error_type: "LoadError" }])
  expect((await startInputs(r2, fake)).history).toEqual([])
  expect(rec.outcome?.waits).toMatchObject([{ node: "chat#1/heard" }])
  expect(userTexts(fake, 0)).toEqual(["next"])
})

test("a code root refusal does not seed the history", async () => {
  const fake = await fakeLlm()
  const a = base()
  const r1 = makeJob(a, "flows/coded.yaml", { inputs: {} })
  expect((await run(r1, new Recorder(), { env: fake.env() })).outcome?.status).toBe("waiting")
  // The fresh run's pin is another folder; its runs folder is A's, so r1's log path is unchanged.
  const b = writeFiles(path.join(tempDir(), "pin"), CHAT_FILES)
  const lines = captureStderr()
  const office = new TemplateOffice()
  const r2 = templateJob("chat", office, {}, { base: { pin: b, runs: a.runs }, run_id: "r2", seed: seedOf(r1, fake) })
  const rec = await run(r2, office, { env: fake.env() })
  expect(rec.outcome?.status).toBe("waiting")
  expect(notSeeded(rec)).toEqual([{ error_type: "RangeError" }])
  expect((await startInputs(r2, fake)).history).toEqual([])
  // r1 recorded A as its code root, so the cancel, held to B, is refused too.
  expect(inspectRun(r1.log).status).toBe("waiting")
  expect(lines.filter((line) => line.includes("the replaced run was not cancelled"))).toEqual([
    "opencorp __worker: the replaced run was not cancelled (RangeError)",
  ])
  expect(lines.filter((line) => [a.pin, b, r1.log].some((secret) => line.includes(secret)))).toEqual([])
})

test("a failed fold still moves the unread messages", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "ok" })
  const r1 = await waitingChat(fake)
  const unread = advanceJob(r1, { advance: false, deliver: [send("m1", "m1")] })
  expect(waitingAt(await run(unread, new TemplateOffice(), { env: fake.env() }))).toEqual(["chat#0/heard"])
  // A yian default r1 didn't run under makes the fold refuse its log, so the unread send is read from the raw records.
  const seed = { log: r1.log, env: { ...fake.env(), YIAN_MAX_EVENT_BYTES: "12345" }, cancel: false }
  const r2 = nextRun(r1, { seed })
  const rec = await run(r2, new TemplateOffice(), { env: fake.env() })
  expect(rec.outcome?.status).toBe("waiting")
  expect(notSeeded(rec)).toEqual([{ error_type: "DefaultsMismatchError" }])
  expect((await startInputs(r2, fake)).history).toEqual([])
  const texts = userTexts(fake, 0)
  expect(texts.at(-1)).toBe("m1")
  expect(texts.filter((text) => text === "m1")).toHaveLength(1)
})

test("unread sends of a failed run reach the fresh run once in order", async () => {
  const fake = await fakeLlm()
  onTestFinished(() => fake.release())
  fake.script({ hold: true, error: 400 }, { content: "ok" }, { content: "ok" })
  const r1 = await waitingChat(fake)
  const office = new TemplateOffice()
  const worker = await inProcessWorker(advanceJob(r1, { deliver: [send("s1", "go")] }), office, {
    env: fake.env(),
  })
  await fake.waitForRequests(1, 30_000)
  for (const text of ["q1", "q2"]) {
    expect(await worker.deliver(send(text, text))).toBe(true)
    await waitFor(() => office.replies.some((reply) => reply.id === text), { timeout: 10_000, what: "the send" })
  }
  expect(office.replies.map((reply) => [reply.id, typeof reply.seq])).toEqual([
    ["s1", "number"],
    ["q1", "number"],
    ["q2", "number"],
  ])
  fake.release()
  expect(await worker.wait()).not.toBeNull()
  expect(office.outcome?.status).toBe("failed")
  const second = new TemplateOffice()
  const r2 = nextRun(r1, { seed: seedOf(r1, fake), deliver: [send("n1", "next")] })
  expect((await run(r2, second, { env: fake.env() })).outcome?.status).toBe("waiting")
  // The moved messages go ahead of the job's own delivery.
  const texts = userTexts(fake, 1)
  expect(texts.slice(-3)).toEqual(["q1", "q2", "next"])
  expect(["q1", "q2", "next", "go"].map((text) => texts.filter((t) => t === text).length)).toEqual([1, 1, 1, 0])
  expect(second.replies.map((reply) => reply.id)).toEqual(["n1"])
})

test("unread sends of a refused advance reach the fresh run once in order", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "ok" })
  const r1 = await waitingChat(fake)
  const toolbox = [{ name: "stub", description: "Does something else.", parameters: EMPTY }]
  const refused = advanceJob(r1, {
    groups: { ...r1.groups, toolbox },
    deliver: [send("a", "a"), send("b", "b")],
  })
  const rec = await run(refused, new TemplateOffice(), { env: fake.env() })
  expect(rec.replies.map((reply) => [reply.id, typeof reply.seq])).toEqual([
    ["a", "number"],
    ["b", "number"],
  ])
  expect(rec.outcome).toEqual({ type: "result", status: "not_resumed", run_id: "r1", error_type: "RangeError" })
  const r2 = nextRun(r1, { seed: seedOf(r1, fake) })
  expect(waitingAt(await run(r2, new TemplateOffice(), { env: fake.env() }))).toEqual(["chat#1/heard"])
  const texts = userTexts(fake, 0)
  expect(texts.slice(-2)).toEqual(["a", "b"])
  expect(["a", "b"].map((text) => texts.filter((t) => t === text).length)).toEqual([1, 1])
})

test("a send a failed reply read as a steer is not moved", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Looking.", tool_calls: [{ name: "toolbox_stub" }] }, { error: 400 })
  const r1 = await waitingChat(fake)
  // The tool returns only once the worker has applied the send, so the reply's next model call reads it as a steer.
  class SendDuringTool extends TemplateOffice {
    override async toolCall(worker: TestWorker, group: string, name: string, args: Record<string, unknown>) {
      await worker.deliver(send("q1", "q1"))
      await waitFor(() => this.replies.some((reply) => reply.id === "q1"), { timeout: 10_000, what: "the reply" })
      return await super.toolCall(worker, group, name, args)
    }
  }
  const failed = await run(advanceJob(r1, { deliver: [send("s1", "go")] }), new SendDuringTool(), {
    env: fake.env(),
  })
  expect(failed.outcome?.status).toBe("failed")
  const q1 = failed.replies.find((reply) => reply.id === "q1")!.seq
  expect(steerSteps(r1)).toEqual([{ kind: "steer", inbox: "messages", from: [q1] }])
  expect(fake.requests().length).toBe(2)
  const r2 = nextRun(r1, { seed: seedOf(r1, fake) })
  expect(waitingAt(await run(r2, new TemplateOffice(), { env: fake.env() }))).toEqual(["chat#0/heard"])
  expect(fake.requests().length).toBe(2)
})

test("an orphan take leaves its messages unread", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "ok" }, { content: "ok" })
  const r1 = await waitingChat(fake)
  const answered = await run(advanceJob(r1, { deliver: [send("s1", "x")] }), new TemplateOffice(), { env: fake.env() })
  expect(waitingAt(answered)).toEqual(["chat#1/heard"])
  // A crash right after the first take's commit leaves it with no success naming it. The log writes a take commit's
  // inbox, events and closed flag beside its key.
  cutAfter(r1.log, (line) => {
    if (line === "") return false
    const record = JSON.parse(line) as { kind: string; payload: Record<string, unknown> }
    const { key, events } = record.payload
    return record.kind === "pool_commit" && key === "chat#0/heard" && Array.isArray(events)
  })
  const r2 = nextRun(r1, { seed: seedOf(r1, fake, false) })
  expect(waitingAt(await run(r2, new TemplateOffice(), { env: fake.env() }))).toEqual(["chat#1/heard"])
  const texts = userTexts(fake, 1)
  expect(texts.at(-1)).toBe("x")
  expect(texts.filter((text) => text === "x")).toHaveLength(1)
  expect((await startInputs(r2, fake)).history).toEqual([])
})

test("the replaced run is cancelled", async () => {
  const fake = await fakeLlm()
  for (const cancel of [true, false]) {
    const r1 = await waitingChat(fake)
    const r2 = nextRun(r1, { seed: seedOf(r1, fake, cancel) })
    expect(waitingAt(await run(r2, new TemplateOffice(), { env: fake.env() }))).toEqual(["chat#0/heard"])
    expect(inspectRun(r1.log).status).toBe(cancel ? "cancelled" : "waiting")
  }
})

test("a refused cancel leaves the fresh run unharmed", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "ok" })
  const where = codedPin()
  // r1 runs in a worker process, as the office runs it, so this process has no compiled flow of r1's to reuse: the
  // cancel recompiles the recorded flow and finds its helper file gone.
  const r1 = makeJob(where, "flows/coded.yaml", { inputs: {} })
  const sessionDir = path.join(tempDir(), "sessions", "s1")
  const first = await runWorker(makeRegistry(), r1, new Recorder(), sessionDir, { env: fake.env() })
  expect(first.outcome?.status).toBe("waiting")
  fs.rmSync(path.join(where.pin, "flows", "helpers.ts"))
  const lines = captureStderr()
  const office = new TemplateOffice()
  const r2 = templateJob("chat", office, {}, {
    base: where,
    run_id: "r2",
    seed: seedOf(r1, fake),
    deliver: [send("n1", "hello")],
  })
  expect(waitingAt(await run(r2, office, { env: fake.env() }))).toEqual(["chat#1/heard"])
  expect(userTexts(fake, 0)).toEqual(["hello"])
  expect(inspectRun(r1.log).status).toBe("waiting")
  expect(lines.filter((line) => line.includes("the replaced run was not cancelled"))).toEqual([
    "opencorp __worker: the replaced run was not cancelled (LoadError)",
  ])
  expect(lines.filter((line) => line.includes(where.pin) || line.includes(r1.log))).toEqual([])
})

test("moved messages that cannot be delivered are dropped quietly", async () => {
  const fake = await fakeLlm()
  const r1 = await waitingChat(fake)
  const unread = advanceJob(r1, { advance: false, deliver: [send("m1", "m1-words")] })
  const delivered = await run(unread, new TemplateOffice(), { env: fake.env() })
  expect(waitingAt(delivered)).toEqual(["chat#0/heard"])
  const lines = captureStderr()
  const rec = new TemplateOffice()
  // An input the flow doesn't declare makes runFlow throw before RunStarted.
  const r2 = nextRun(r1, { inputs: { ...r1.inputs, nope: 1 }, seed: seedOf(r1, fake, false) })
  await run(r2, rec, { env: fake.env() })
  expect(rec.outcome?.type).toBe("error")
  expect(rec.replies.filter((reply) => reply.id === "moved-0")).toEqual([])
  const moved = lines.filter((line) => line.includes("moved message"))
  expect(moved).toEqual(["opencorp __worker: a moved message was not delivered (not_started)"])
  expect(lines.filter((line) => line.includes("m1-words"))).toEqual([])
  expect(fake.requests()).toEqual([])
})

test("a carried history over the frame limit goes as a stubbed NodeExpanded and the next turn runs", async () => {
  const stderr = captureStderr()
  const fake = await fakeLlm()
  const big = `${"w".repeat(1023)} `.repeat(100)
  fake.script({ content: big }, { content: "ok" })
  const first = new TemplateOffice()
  const r1 = templateJob("chat", first, {}, { deliver: [send("s1", "hi")], keep: false })
  const w1 = await inProcessWorker(r1, first, { env: fake.env(), maxFrame: 96 * 1024 })
  await w1.wait()
  expect(first.outcome?.status).toBe("waiting")
  const expanded = first.frames
    .filter((frame) => frame.name === "NodeExpanded")
    .map((frame) => frame.data as { node_id: string; grow: { seed: unknown } })
    .filter((data) => /^chat~\d+$/.test(data.node_id))
  expect(expanded.length).toBeGreaterThan(0)
  expect(expanded.at(-1)!.grow.seed).toBeNull()
  // The reply still names its node, so the office counts the turn.
  const reply = first.frames.find(
    (frame) => frame.name === "NodeSucceeded" && (frame.data as Frame).node_id === "chat#0/reply",
  )
  expect(reply?.data).toMatchObject({ output: null })
  const second = new TemplateOffice()
  const w2 = await inProcessWorker(advanceJob(r1, { deliver: [send("s2", "again")] }), second, {
    env: fake.env(),
    maxFrame: 96 * 1024,
  })
  await w2.wait()
  expect(second.outcome?.status).toBe("waiting")
  expect(stderr).toContain("opencorp __worker: a NodeExpanded event frame went without its values")
  expect(stderr.join("\n")).not.toContain("wwww")
  // Yian kept the history though its event went as a stub.
  const texts = (fake.requests().at(-1)!.messages as Record<string, unknown>[]).map((m) => JSON.stringify(m.content))
  expect(texts.some((text) => text.includes("wwww"))).toBe(true)
})

/** A session's transcript, read from its runs' logs (Python's `tests/chat/test_transcript.py`). */
import { expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { iterRunRecords, type LiveViewCall, type PoolCommitRecord, type RunLogEntry } from "@ngocbh/yian/run"
import { pending } from "@ngocbh/yian/tools"
import { Message, type ToolPart } from "@opencorp/protocol"
import { type LiveCalls, tooLargeText, Transcript } from "../../src/chat/transcript.ts"
import { MAIN_CHAT } from "../../src/chat/turns.ts"
import { newId } from "../../src/store/store.ts"
import type { FakeLLM } from "../../src/testing/fake_llm.ts"
import type { Delivery, Job } from "../../src/worker/job.ts"
import { tempDir, waitFor } from "../helpers.ts"
import { line, RUN, runStarted, started } from "../runs/helpers.ts"
import { advanceJob, inProcessWorker, run, type TestWorker } from "../worker/helpers.ts"
import {
  advance,
  fakeLlm,
  interruptMidReply,
  logPrefix,
  PERSON,
  send,
  TemplateOffice,
  templateJob,
  waitingAt,
  waitingChat,
} from "./helpers.ts"

setDefaultTimeout(30_000)

/** The messages of the runs `runIds` under `runs`, read by `transcript` (a fresh one by default) with `live`, each
 *  checked against the protocol's `Message`, their ids checked to sort in transcript order. */
function messages(
  runs: string,
  sessionId: string,
  runIds: string[],
  { transcript = new Transcript(runs), live }: { transcript?: Transcript; live?: LiveCalls } = {},
): Message[] {
  const read = transcript.messages(sessionId, runIds, live)
  for (const message of read) Message.parse(message)
  const ids = read.map((m) => m.id)
  expect(ids).toEqual([...ids].sort())
  return read
}

/** Each message as its role and its text parts' texts. */
function texts(read: Message[]): [string, string[]][] {
  return read.map((m) => [m.role, m.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))])
}

/** Each message as its role and what each part shows: a text part's text, a tool part's state. */
function shown(read: Message[]): [string, string[]][] {
  return read.map((m) => [
    m.role,
    m.parts.map((part) => (part.type === "text" ? part.text : part.type === "tool" ? part.state : part.type)),
  ])
}

/** Each tool part of `read` as its call id, state, output and error. */
function tools(read: Message[]): [string, string, unknown, string | null | undefined][] {
  return read.flatMap((m) =>
    m.parts.flatMap((part) => (part.type === "tool" ? [[part.call_id, part.state, part.output, part.error]] : [])),
  ) as [string, string, unknown, string | null | undefined][]
}

/** A step as the log holds it. */
type Step = Record<string, unknown>

/** The step of each `node_step` record in the log `log`. */
function steps(log: string): Record<string, unknown>[] {
  return [...iterRunRecords(log, { kinds: ["node_step"] })].map(
    (entry) => (entry.envelope.record as unknown as { step: Record<string, unknown> }).step,
  )
}

/** Live calls that say `calls` for every run. */
function liveCalls(calls: LiveViewCall[]): LiveCalls {
  return { calls: () => calls }
}

/** Overwrites the first byte of the log `log`, so a read from its start fails at its first record. */
function corrupt(log: string): void {
  const fd = fs.openSync(log, "r+")
  try {
    fs.writeSync(fd, "x", 0)
  } finally {
    fs.closeSync(fd)
  }
}

/** Applies `deliver` to the waiting run `job` without moving it on. */
async function apply(job: Job, fake: FakeLLM, deliver: Delivery[]): Promise<void> {
  await run(advanceJob(job, { deliver, advance: false }), new TemplateOffice(), { env: fake.env() })
}

test("a user message comes from its turns take commit", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hello both." })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  await advance(job, fake, [send("s1", "one"), send("s2", "two")])
  const read = messages(runs, newId(), ["r1"])
  expect(texts(read).slice(0, 2)).toEqual([
    ["user", ["one"]],
    ["user", ["two"]],
  ])
  const sends = [...iterRunRecords(job.log, { kinds: ["pool_commit"] })].filter((entry) =>
    (entry.envelope.record as PoolCommitRecord).key.endsWith(".messages"),
  )
  expect(sends.length).toBe(2)
  sends.forEach((entry, i) => {
    expect(read[i]!.id).toBe(`r1:${String(entry.seq).padStart(12, "0")}`)
    expect(read[i]!.parts[0]!.id).toBe(`${read[i]!.id}:0`)
    expect(read[i]!.created_at).toBe(entry.at)
  })
})

test("a user message can name its author", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Done." })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  await advance(job, fake, [send("s1", "approve it", "ngocbh"), send("s2", "composer message")])
  const read = messages(runs, newId(), ["r1"])
  expect(read.filter((m) => m.role === "user").map((m) => m.author)).toEqual(["ngocbh", null])
})

test("a turn context part never shows", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hi." })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  const event = { role: "user", parts: [{ type: "text", text: "Context: seed" }, { type: "text", text: "hi" }] }
  await advance(job, fake, [{ id: "s1", op: "send", inbox: "messages", event }])
  const read = messages(runs, newId(), ["r1"])
  expect(texts(read.filter((m) => m.role === "user"))).toEqual([["user", ["hi"]]])
})

test("a send no take has read is a queued message of the last run only", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hi." })
  const runs = tempDir()
  const first = await waitingChat(fake, "chat", {}, { runs, runId: "r1" })
  await advance(first, fake, [send("s1", "one")])
  await apply(first, fake, [send("s2", "lost")])
  const second = await waitingChat(fake, "chat", {}, { runs, runId: "r2" })
  await apply(second, fake, [send("s3", "queued")])
  const read = messages(runs, newId(), ["r1", "r2"])
  expect(texts(read.filter((m) => m.role === "user"))).toEqual([
    ["user", ["one"]],
    ["user", ["queued"]],
  ])
  expect(read.at(-1)!.id.startsWith("r2:")).toBe(true)
  expect(texts([read.at(-1)!])).toEqual([["user", ["queued"]]])
})

test("an orphan take commit leaves its messages queued", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hello both." })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  await advance(job, fake, [send("s1", "one"), send("s2", "two")])
  const crashed = tempDir()
  const turnDone = (entry: RunLogEntry) => entry.kind === "node_succeeded" && MAIN_CHAT.isTurn(entry.nodeId)
  const cut = logPrefix(job.log, (entry) => !turnDone(entry), crashed)
  const takes = [...iterRunRecords(cut, { kinds: ["pool_commit"] })].filter(
    (entry) => (entry.envelope.record as PoolCommitRecord).take !== null,
  )
  expect(takes.length).toBe(1)
  const read = messages(crashed, newId(), ["r1"])
  expect(texts(read)).toEqual([
    ["user", ["one"]],
    ["user", ["two"]],
  ])
})

/** A chat run whose reply calls the toolbox's `shell` three times and `search` once, its last shell call answering
 *  last; its job, run to waiting at the next turn under `runs` as `r1`. */
async function toolRun(runs: string): Promise<Job> {
  const fake = await fakeLlm()
  fake.script(
    {
      content: "",
      tool_calls: [
        { id: "c1", name: "toolbox_shell", arguments: { command: "ls", count: 3 } },
        { id: "c2", name: "toolbox_search", arguments: { pattern: "x" } },
        { id: "c3", name: "toolbox_shell", arguments: { command: "sleep 9" } },
      ],
    },
    { content: "done" },
  )
  const shell = {
    description: "Runs a command.",
    parameters: { type: "object", properties: { command: { type: "string" }, count: { type: "integer" } } },
    call: async (args: Record<string, unknown>) => {
      if (args.command === "sleep 9") {
        const results = () => steps(job.log).filter((step) => step.kind === "tool_result").length
        await waitFor(() => results() === 2, { timeout: 10_000, what: "c1 and c2 results" })
      }
      return "a.txt"
    },
  }
  const search = {
    description: "Searches.",
    parameters: { type: "object", properties: { pattern: { type: "string" } } },
    call: () => {
      throw new Error("no index")
    },
  }
  const office = new TemplateOffice("chat", { toolbox: { shell, search } })
  const job = templateJob("chat", office, {}, { runs })
  await run(job, office, { env: fake.env() })
  const rec = await run(advanceJob(job, { deliver: [send("s1", "go")] }), office, { env: fake.env() })
  expect(waitingAt(rec)).toEqual(["chat#1/heard"])
  return job
}

/** The log of `job` cut before c3's tool result, under a fresh runs folder; returns that folder. */
function beforeC3(job: Job): string {
  const crashed = tempDir()
  const c3Result = (entry: RunLogEntry) => {
    if (entry.kind !== "node_step") return false
    const { step } = entry.envelope.record as unknown as { step: Record<string, unknown> }
    return step.kind === "tool_result" && step.call_id === "c3"
  }
  logPrefix(job.log, (entry) => !c3Result(entry), crashed)
  return crashed
}

test("tool calls become tool parts", async () => {
  const runs = tempDir()
  const job = await toolRun(runs)
  const read = messages(runs, newId(), ["r1"])
  const recorded = steps(job.log).find((step) => step.kind === "tool_result" && step.call_id === "c2")!
  expect(recorded.is_error).toBe(true)
  expect(tools(read)).toEqual([
    ["c1", "completed", "a.txt", null],
    ["c2", "error", {}, recorded.output as string],
    ["c3", "completed", "a.txt", null],
  ])
  expect(texts(read)).toEqual([
    ["user", ["go"]],
    ["assistant", ["done"]],
  ])
  const c1 = read[1]!.parts.find((part) => part.type === "tool" && part.call_id === "c1") as ToolPart
  expect(c1.input).toEqual({ command: "ls", count: 3 })
  expect(() => JSON.stringify(read)).not.toThrow()
  expect(tools(messages(beforeC3(job), newId(), ["r1"]))[2]).toEqual(["c3", "interrupted", {}, null])
})

test("a live run shows a call without its result as running", async () => {
  const job = await toolRun(tempDir())
  const crashed = beforeC3(job)
  const read = messages(crashed, newId(), ["r1"], { live: liveCalls([]) })
  expect(tools(read)[2]).toEqual(["c3", "running", {}, null])
  // Only the session's last run is asked for its live calls; an earlier one left its call cut.
  fs.mkdirSync(path.join(crashed, "r2"))
  fs.copyFileSync(job.log, path.join(crashed, "r2", "log.jsonl"))
  const asked: string[] = []
  const live = {
    calls: (runId: string) => {
      asked.push(runId)
      return []
    },
  }
  expect(tools(messages(crashed, newId(), ["r1", "r2"], { live }))[2]).toEqual(["c3", "interrupted", {}, null])
  expect(asked).toEqual(["r2"])
})

test("a node that never called a model writes nothing", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "SUMMARY-OF-TURN-0" }, { content: "Hello." })
  const history = [0, 1, 2, 3, 4].map((k) => [
    { role: "user", parts: [{ type: "text", text: `u${k}`.padEnd(8000, "u") }] },
    { role: "assistant", parts: [{ type: "text", text: `a${k}`.padEnd(8000, "a") }] },
  ])
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", { history }, { runs })
  await advance(job, fake, [send("s1", "next")])
  expect(fake.requests().length).toBe(2)
  expect(texts(messages(runs, newId(), ["r1"]))).toEqual([
    ["user", ["next"]],
    ["assistant", ["Hello."]],
  ])
})

test("each occurrence gets its own message", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  await advance(job, fake, [send("s1", "first")])
  await advance(job, fake, [send("s2", "second")])
  const read = messages(runs, newId(), ["r1"])
  expect(texts(read.filter((m) => m.role === "assistant")).map(([, said]) => said)).toEqual([["one"], ["two"]])
})

test("a run nothing runs shows a call a crash left without its result as interrupted", async () => {
  const job = await toolRun(tempDir())
  const read = messages(beforeC3(job), newId(), ["r1"])
  expect(tools(read)).toEqual([
    ["c1", "completed", "a.txt", null],
    ["c2", "error", {}, expect.any(String)],
    ["c3", "interrupted", {}, null],
  ])
  expect(texts(read)).toEqual([
    ["user", ["go"]],
    ["assistant", []],
  ])
})

test("a failed model attempt shows nothing", async () => {
  const fake = await fakeLlm()
  fake.script({ error: 500 })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  await advance(job, fake, [send("s1", "hi")])
  expect(steps(job.log).some((step) => step.kind === "model_call" && step.error != null)).toBe(true)
  const read = messages(runs, newId(), ["r1"])
  expect(texts(read)).toEqual([["user", ["hi"]]])
  expect(read.map((m) => m.parts.length)).toEqual([1])
})

test("a tool call whose arguments did not parse shows no tool part", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Trying.", tool_calls: [{ id: "bad", name: "workspace_shell", arguments: "{not json" }] })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  await advance(job, fake, [send("s1", "hi")])
  const call = steps(job.log).find((step) => step.kind === "model_call" && step.purpose === "chat")!
  const parts = (call.output as { parts: Step[] }).parts
  expect(parts.find((part) => part.type === "tool_call")).toEqual({
    type: "tool_call",
    id: "bad",
    name: "workspace_shell",
    raw_arguments: "{not json",
  })
  expect(shown(messages(runs, newId(), ["r1"]))).toEqual([
    ["user", ["hi"]],
    ["assistant", ["Trying."]],
  ])
})

test("a waiting ask user call shows running while the session sleeps", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "", tool_calls: [{ id: "q1", name: "ask_user", arguments: { question: "Which?" } }] })
  class Asking extends TemplateOffice {
    override askUser(): unknown {
      return pending()
    }
  }
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  const rec = await run(advanceJob(job, { deliver: [send("s1", "pick one")] }), new Asking(), { env: fake.env() })
  expect(waitingAt(rec)).toEqual(["chat#0/reply"])
  expect(tools(messages(runs, newId(), ["r1"]))).toEqual([["q1", "running", {}, null]])
  await apply(job, fake, [{ id: "x", op: "cancel" }])
  expect(tools(messages(runs, newId(), ["r1"]))).toEqual([["q1", "interrupted", {}, null]])
  await waitingChat(fake, "chat", {}, { runs, runId: "r2" })
  expect(tools(messages(runs, newId(), ["r1", "r2"]))).toEqual([["q1", "interrupted", {}, null]])
})

/** A template office whose tool calls first deliver `delivery` to the run and wait for its reply. */
class DeliverDuringTool extends TemplateOffice {
  constructor(private readonly delivery: Delivery) {
    super()
  }

  override async toolCall(worker: TestWorker, group: string, name: string, args: Record<string, unknown>) {
    await worker.deliver(this.delivery)
    const delivered = () => this.replies.some((reply) => reply.id === this.delivery.id)
    await waitFor(delivered, { timeout: 10_000, what: "the reply" })
    return await super.toolCall(worker, group, name, args)
  }
}

test("a user message mid reply comes before what the model says after reading it", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Working", tool_calls: [{ id: "c1", name: "toolbox_stub" }] }, { content: "Rome." })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  const office = new DeliverDuringTool(send("during", "Also mention Rome."))
  await run(advanceJob(job, { deliver: [send("s1", "Plan the trip.")] }), office, { env: fake.env() })
  const read = messages(runs, newId(), ["r1"])
  expect(shown(read)).toEqual([
    ["user", ["Plan the trip."]],
    ["assistant", ["Working", "completed"]],
    ["user", ["Also mention Rome."]],
    ["assistant", ["Rome."]],
  ])
  const times = read.map((m) => m.created_at)
  expect(times).toEqual([...times].sort())
  const reply = (entry: RunLogEntry) => entry.nodeId === "chat#0/reply"
  const started = [...iterRunRecords(job.log, { kinds: ["node_started"] })].find(reply)!
  const replySteps = [...iterRunRecords(job.log, { kinds: ["node_step"] })].filter(reply)
  const record = (entry: RunLogEntry) => entry.envelope.record as unknown as { n: number; step: Step }
  const call = replySteps.find((entry) => record(entry).step.kind === "model_call")!
  const steer = replySteps.find((entry) => record(entry).step.kind === "steer")!
  expect(read[1]!.id).toBe(`r1:${String(started.seq).padStart(12, "0")}`)
  expect(read[3]!.id).toBe(`r1:${String(steer.seq).padStart(12, "0")}`)
  expect(read[3]!.created_at).toBe(steer.at)
  expect(read[1]!.parts.map((part) => part.id)).toEqual([
    `r1:chat#0/reply:${record(call).n}`,
    `r1:chat#0/reply:${record(call).n}:0`,
  ])
})

test("a reply that streams nothing after a user message gets its output after it", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Working", hold: true }, { content: "Rome." })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  const office = new TemplateOffice()
  const worker = await inProcessWorker(advanceJob(job, { deliver: [send("s1", "Plan the trip.")] }), office, {
    env: fake.env(),
  })
  await fake.waitForRequests(1, 30_000)
  expect(await worker.deliver(send("during", "Also mention Rome."))).toBe(true)
  await waitFor(() => office.replies.some((reply) => reply.id === "during"), { timeout: 10_000, what: "the send" })
  fake.release()
  expect(await worker.wait()).not.toBeNull()
  expect(fake.requests().length).toBe(2)
  expect(shown(messages(runs, newId(), ["r1"]))).toEqual([
    ["user", ["Plan the trip."]],
    ["assistant", ["Working"]],
    ["user", ["Also mention Rome."]],
    ["assistant", ["Rome."]],
  ])
})

test("a user message the reply never reads comes after it", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Done." })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  await advance(job, fake, [send("s1", "do it")])
  await apply(job, fake, [send("s2", "one more thing")])
  expect(shown(messages(runs, newId(), ["r1"]))).toEqual([
    ["user", ["do it"]],
    ["assistant", ["Done."]],
    ["user", ["one more thing"]],
  ])
})

test("an interrupted reply ends with the interrupted marker", async () => {
  const fake = await fakeLlm()
  const runs = tempDir()
  await interruptMidReply(fake, { content: "Thinking about it" }, { runs })
  const transcript = new Transcript(runs)
  const sessionId = newId()
  const read = messages(runs, sessionId, ["r1"], { transcript })
  // The interrupt stopped the held model call before its first chunk, so none of its text landed.
  expect(shown(read)).toEqual([
    ["user", ["one"]],
    ["assistant", ["[interrupted]"]],
    ["user", ["queued"]],
    ["assistant", ["Got it."]],
  ])
  expect(messages(runs, sessionId, ["r1"], { transcript })).toEqual(read)
})

test("a reply interrupted after its first chunk keeps that text, and the marker ends it", async () => {
  const fake = await fakeLlm()
  const runs = tempDir()
  await interruptMidReply(fake, { content: "Thinking about it", hold_after: 1 }, { runs })
  expect(shown(messages(runs, newId(), ["r1"]))).toEqual([
    ["user", ["one"]],
    ["assistant", ["Thinking \n\n[interrupted]"]],
    ["user", ["queued"]],
    ["assistant", ["Got it."]],
  ])
})

test("a reply interrupted after a tool call ends with the marker after it", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Working", tool_calls: [{ id: "c1", name: "toolbox_stub" }] }, { content: "Unused." })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  const office = new DeliverDuringTool({ id: "cut", op: "interrupt", inbox: "messages" })
  const rec = await run(advanceJob(job, { deliver: [send("s1", "Plan the trip.")] }), office, { env: fake.env() })
  expect(waitingAt(rec)).toEqual(["chat#1/heard"])
  const transcript = new Transcript(runs)
  const sessionId = newId()
  const read = messages(runs, sessionId, ["r1"], { transcript })
  expect(shown(read)).toEqual([
    ["user", ["Plan the trip."]],
    ["assistant", ["Working", "completed", "[interrupted]"]],
  ])
  expect(messages(runs, sessionId, ["r1"], { transcript })).toEqual(read)
  const cut = [...iterRunRecords(job.log, { kinds: ["node_step"] })].find(
    (entry) => (entry.envelope.record as unknown as { step: Step }).step.kind === "interrupted",
  )!
  expect(read[1]!.parts.at(-1)!.id).toBe(`r1:chat#0/reply:${(cut.envelope.record as unknown as { n: number }).n}`)
})

test("a reply interrupted during a tool call shows the call it cut and the marker", async () => {
  const fake = await fakeLlm()
  const calls = [
    { id: "c1", name: "toolbox_stub" },
    { id: "c2", name: "toolbox_stub" },
  ]
  fake.script({ content: "", tool_calls: calls }, { content: "Unused." })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  const office = new DeliverDuringTool({ id: "cut", op: "interrupt", inbox: "messages" })
  const rec = await run(advanceJob(job, { deliver: [send("s1", "Plan the trip.")] }), office, { env: fake.env() })
  expect(waitingAt(rec)).toEqual(["chat#1/heard"])
  const reply = messages(runs, newId(), ["r1"])[1]!
  expect(reply.role).toBe("assistant")
  expect(tools([reply])).toEqual([
    ["c1", "completed", "ok", null],
    ["c2", "interrupted", {}, "Not run: interrupted by the user."],
  ])
  expect(shown([reply])).toEqual([["assistant", ["completed", "interrupted", "[interrupted]"]]])
})

test("the transcript shows nothing of the runs inputs or other nodes", async () => {
  const hidden = "NOT-IN-THE-TRANSCRIPT"
  const fake = await fakeLlm()
  fake.script({ content: `${hidden} 0` }, { content: "Hello." })
  const history = [0, 1, 2, 3, 4].map((k) => [
    { role: "user", parts: [{ type: "text", text: `${hidden} u${k}`.padEnd(8000, "u") }] },
    { role: "assistant", parts: [{ type: "text", text: `${hidden} a${k}`.padEnd(8000, "a") }] },
  ])
  const runs = tempDir()
  const inputs = { person: { ...PERSON, title: hidden }, summary: hidden, history }
  const job = await waitingChat(fake, "chat", inputs, { runs })
  await advance(job, fake, [send("s1", "next")])
  expect(fake.requests().length).toBe(2)
  const log = fs.readFileSync(job.log, "utf8")
  expect(log).toContain(`${hidden} 0`) // the summariser's reply
  expect(log.split(hidden).length).toBeGreaterThan(10)
  const read = messages(runs, newId(), ["r1"])
  expect(JSON.stringify(read)).not.toContain(hidden)
  expect(texts(read)).toEqual([
    ["user", ["next"]],
    ["assistant", ["Hello."]],
  ])
})

test("messages of every run come in run order and their ids sort in that order", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "First." }, { content: "Second." })
  const runs = tempDir()
  const runIds = [newId(), newId()]
  for (const [i, runId] of runIds.entries()) {
    const job = await waitingChat(fake, "chat", {}, { runs, runId })
    await advance(job, fake, [send(`s${i}`, `message ${i}`)])
  }
  const read = messages(runs, newId(), runIds)
  expect(texts(read)).toEqual([
    ["user", ["message 0"]],
    ["assistant", ["First."]],
    ["user", ["message 1"]],
    ["assistant", ["Second."]],
  ])
  expect(read.map((m) => m.id.split(":")[0])).toEqual([runIds[0], runIds[0], runIds[1], runIds[1]])
})

test("a reply in flight shows its live text under the id its step gets", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "hello there" })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  await advance(job, fake, [send("s1", "hi")])
  const isCall = (entry: RunLogEntry) =>
    entry.kind === "node_step" &&
    entry.nodeId === "chat#0/reply" &&
    (entry.envelope.record as unknown as { step: Step }).step.kind === "model_call"
  const call = [...iterRunRecords(job.log)].find(isCall)!
  const n = (call.envelope.record as unknown as { n: number }).n
  const crashed = tempDir()
  logPrefix(job.log, (entry) => !isCall(entry), crashed)
  const transcript = new Transcript(crashed)
  const sessionId = newId()
  const replies = (live?: LiveCalls) =>
    messages(crashed, sessionId, ["r1"], { transcript, live })
      .filter((m) => m.role === "assistant")
      .map((m) => m.parts)
  const live = liveCalls([{ node: "chat#0/reply", n, text: "hello ", nextIndex: 1 }])
  expect(replies(live)).toEqual([[{ id: `r1:chat#0/reply:${n}`, type: "text", text: "hello " }]])
  // The live part is not kept: a read without live calls shows none.
  expect(replies()).toEqual([])
  // A call that has streamed nothing yet still shows; a call for a node the run never started, or for a node
  // other than a reply, does not.
  const quiet = liveCalls([
    { node: "chat#0/reply", n, text: "", nextIndex: 0 },
    { node: "chat#9/reply", n: 0, text: "x", nextIndex: 1 },
    { node: "chat#0/context/compacted/folded/summarize", n: 1, text: "SUMMARY", nextIndex: 1 },
  ])
  expect(replies(quiet)).toEqual([[{ id: `r1:chat#0/reply:${n}`, type: "text", text: "" }]])
  const full = messages(runs, newId(), ["r1"]).filter((m) => m.role === "assistant")
  expect(full.map((m) => m.parts)).toEqual([[{ id: `r1:chat#0/reply:${n}`, type: "text", text: "hello there" }]])
  // A live call goes last in its node's message, after what the node recorded.
  const next = liveCalls([{ node: "chat#0/reply", n: n + 1, text: "more", nextIndex: 1 }])
  const after = messages(runs, newId(), ["r1"], { live: next }).filter((m) => m.role === "assistant")
  expect(after.map((m) => m.parts)).toEqual([
    [
      { id: `r1:chat#0/reply:${n}`, type: "text", text: "hello there" },
      { id: `r1:chat#0/reply:${n + 1}`, type: "text", text: "more" },
    ],
  ])
})

test("reads are incremental", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  await advance(job, fake, [send("s1", "first")])
  const transcript = new Transcript(runs)
  const sessionId = newId()
  expect(texts(messages(runs, sessionId, ["r1"], { transcript }))).toEqual([
    ["user", ["first"]],
    ["assistant", ["one"]],
  ])
  await advance(job, fake, [send("s2", "second")])
  corrupt(job.log)
  expect(new Transcript(runs, { log: () => {} }).messages(sessionId, ["r1"])).toEqual([])
  expect(texts(messages(runs, sessionId, ["r1"], { transcript }))).toEqual([
    ["user", ["first"]],
    ["assistant", ["one"]],
    ["user", ["second"]],
    ["assistant", ["two"]],
  ])
})

test("a log that no longer continues is read again from the start", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  await advance(job, fake, [send("s1", "first")])
  const prefix = fs.readFileSync(job.log)
  await advance(job, fake, [send("s2", "second")])
  const transcript = new Transcript(runs)
  const sessionId = newId()
  expect(messages(runs, sessionId, ["r1"], { transcript }).length).toBe(4)
  fs.writeFileSync(job.log, prefix)
  expect(texts(messages(runs, sessionId, ["r1"], { transcript }))).toEqual([
    ["user", ["first"]],
    ["assistant", ["one"]],
  ])
})

test("the cache keeps at most max bytes and forgets ended runs", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "A." }, { content: "B." })
  const runs = tempDir()
  const a = await waitingChat(fake, "chat", {}, { runs, runId: "a" })
  await advance(a, fake, [send("s1", "to a")])
  const b = await waitingChat(fake, "chat", {}, { runs, runId: "b" })
  await advance(b, fake, [send("s2", "to b")])
  const transcript = new Transcript(runs, { maxBytes: 1, log: () => {} })
  const sessionId = newId()
  expect(messages(runs, sessionId, ["a"], { transcript }).length).toBe(2)
  expect(messages(runs, sessionId, ["b"], { transcript }).length).toBe(2)
  corrupt(a.log)
  corrupt(b.log)
  expect(texts(messages(runs, sessionId, ["b"], { transcript }))).toEqual([
    ["user", ["to b"]],
    ["assistant", ["B."]],
  ])
  transcript.forget(["b"])
  expect(transcript.messages(sessionId, ["b"])).toEqual([])
  expect(transcript.messages(sessionId, ["a"])).toEqual([])
})

test("a bad line shows the messages up to it and logs once", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  await advance(job, fake, [send("s1", "first")])
  await advance(job, fake, [send("s2", "second")])
  fs.appendFileSync(job.log, "garbage\n")
  const logs: string[] = []
  const transcript = new Transcript(runs, { log: (line) => logs.push(line) })
  const sessionId = newId()
  const want: [string, string[]][] = [
    ["user", ["first"]],
    ["assistant", ["one"]],
    ["user", ["second"]],
    ["assistant", ["two"]],
  ]
  expect(texts(messages(runs, sessionId, ["r1"], { transcript }))).toEqual(want)
  expect(texts(messages(runs, sessionId, ["r1"], { transcript }))).toEqual(want)
  expect(logs.length).toBe(1)
  expect(logs[0]).toMatch(/^run r1: the transcript stops after record \d+ \(RangeError: a line of its log can't be read\)/)
  expect(logs[0]).not.toContain(runs)
})

test("a line with the wrong schema stops the transcript the same way", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  await advance(job, fake, [send("s1", "first")])
  fs.appendFileSync(job.log, `${JSON.stringify({ schema: 999, run_id: "r1" })}\n`)
  const logs: string[] = []
  const transcript = new Transcript(runs, { log: (line) => logs.push(line) })
  expect(texts(messages(runs, newId(), ["r1"], { transcript }))).toEqual([
    ["user", ["first"]],
    ["assistant", ["one"]],
  ])
  expect(logs).toEqual([expect.stringMatching(/stops after record \d+ \(RunLogSchemaError: /)])
})

test("a bad first line reads as no messages", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  await advance(job, fake, [send("s1", "first")])
  corrupt(job.log)
  const logs: string[] = []
  const transcript = new Transcript(runs, { log: (line) => logs.push(line) })
  expect(messages(runs, newId(), ["r1"], { transcript })).toEqual([])
  expect(logs).toEqual([
    "run r1: the transcript stops before its first record (RangeError: a line of its log can't be read)",
  ])
})

test("a bad line that was rewritten reads on past it", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  await advance(job, fake, [send("s1", "first")])
  const good = fs.readFileSync(job.log)
  fs.appendFileSync(job.log, "garbage\n")
  const transcript = new Transcript(runs, { log: () => {} })
  const sessionId = newId()
  expect(messages(runs, sessionId, ["r1"], { transcript }).length).toBe(2)
  fs.writeFileSync(job.log, good)
  await advance(job, fake, [send("s2", "second")])
  expect(texts(messages(runs, sessionId, ["r1"], { transcript }))).toEqual([
    ["user", ["first"]],
    ["assistant", ["one"]],
    ["user", ["second"]],
    ["assistant", ["two"]],
  ])
})

test("a runs path that is a file reads as no messages", () => {
  const runs = path.join(tempDir(), "runs")
  fs.writeFileSync(runs, "")
  const logs: string[] = []
  const transcript = new Transcript(runs, { log: (line) => logs.push(line) })
  expect(messages(runs, newId(), ["r1"], { transcript })).toEqual([])
  expect(logs).toEqual([])
})

test.skipIf(process.getuid?.() === 0)("an unreadable run folder reads as no messages and logs its code once", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  await advance(job, fake, [send("s1", "first")])
  const folder = path.dirname(job.log)
  const logs: string[] = []
  const transcript = new Transcript(runs, { log: (line) => logs.push(line) })
  fs.chmodSync(folder, 0o000)
  try {
    expect(messages(runs, newId(), ["r1"], { transcript })).toEqual([])
    expect(messages(runs, newId(), ["r1"], { transcript })).toEqual([])
  } finally {
    fs.chmodSync(folder, 0o700)
  }
  expect(logs).toEqual(["run r1: its log can't be read (EACCES); it shows no messages"])
  expect(messages(runs, newId(), ["r1"], { transcript }).length).toBe(2)
})

test.skipIf(process.getuid?.() === 0)("an unreadable folder, then a bad line, of the same run logs both", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  await advance(job, fake, [send("s1", "first")])
  const folder = path.dirname(job.log)
  const logs: string[] = []
  const transcript = new Transcript(runs, { log: (line) => logs.push(line) })
  fs.chmodSync(folder, 0o000)
  try {
    expect(messages(runs, newId(), ["r1"], { transcript })).toEqual([])
  } finally {
    fs.chmodSync(folder, 0o700)
  }
  fs.appendFileSync(job.log, "garbage\n")
  expect(messages(runs, newId(), ["r1"], { transcript }).length).toBe(2)
  expect(messages(runs, newId(), ["r1"], { transcript }).length).toBe(2)
  expect(logs).toEqual([
    "run r1: its log can't be read (EACCES); it shows no messages",
    expect.stringMatching(/^run r1: the transcript stops after record \d+ /),
  ])
})

test("a run without a log yet has no messages", () => {
  expect(messages(tempDir(), newId(), ["r1"])).toEqual([])
})

test("a run id that is not one folder name is skipped", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hi." })
  const runs = path.join(tempDir(), "runs")
  const job = await waitingChat(fake, "chat", {}, { runs })
  await advance(job, fake, [send("s1", "hi")])
  expect(messages(runs, newId(), ["r1"]).length).toBe(2)
  expect(messages(runs, newId(), ["", ".", "..", "../runs/r1", "r1/..", "r1\\x", "r1\0"])).toEqual([])
})

/** The `node_step` entry of the first `kind` step of node `node` in the log `log`, its `n` and its line's size. */
function stepEntry(log: string, node: string, kind: string): { n: number; size: number } {
  for (const entry of iterRunRecords(log)) {
    const record = entry.envelope.record as unknown as { n?: number; step?: Step }
    if (entry.kind === "node_step" && entry.nodeId === node && record.step?.kind === kind) {
      return { n: record.n!, size: entry.end - entry.offset }
    }
  }
  throw new Error(`no ${kind} step of ${node}`)
}

/** A run whose first reply says 40,000 characters, then a second turn "Two.", under `runs` as `r1`. */
async function bigReply(runs: string): Promise<{ log: string; n: number; size: number }> {
  const fake = await fakeLlm()
  fake.script({ content: "x".repeat(40_000) }, { content: "Two." })
  const job = await waitingChat(fake, "chat", {}, { runs })
  await advance(job, fake, [send("s1", "one")])
  await advance(job, fake, [send("s2", "two")])
  return { log: job.log, ...stepEntry(job.log, "chat#0/reply", "model_call") }
}

test("a reply step over the line cap shows its size, and the turns after it still show", async () => {
  const runs = tempDir()
  const { n, size } = await bigReply(runs)
  expect(size).toBeGreaterThan(16_384)
  const read = messages(runs, newId(), ["r1"], { transcript: new Transcript(runs, { lineCap: 16_384 }) })
  expect(texts(read)).toEqual([
    ["user", ["one"]],
    ["assistant", [tooLargeText(size)]],
    ["user", ["two"]],
    ["assistant", ["Two."]],
  ])
  expect(read[1]!.parts[0]!.id).toBe(`r1:chat#0/reply:${n}`)
  expect(tooLargeText(3 * 2 ** 20)).toBe("(too large to show: 3.0 MiB)")
})

test("a live call on a reply step over the line cap shows once", async () => {
  const runs = tempDir()
  const { n, size } = await bigReply(runs)
  const live = liveCalls([{ node: "chat#0/reply", n, text: "partial", nextIndex: 1 }])
  const read = messages(runs, newId(), ["r1"], { transcript: new Transcript(runs, { lineCap: 16_384 }), live })
  const parts = read.flatMap((m) => m.parts).filter((part) => part.id === `r1:chat#0/reply:${n}`)
  expect(parts).toEqual([{ id: `r1:chat#0/reply:${n}`, type: "text", text: tooLargeText(size) }])
})

const REPLY = "chat#0/reply"

/** A hand-built log under `runs` (as RUN): the run's start, the reply's start, a model call of one tool, and a
 *  tool result whose output is `output`, with `extra` fields; returns the tool result line's size. */
function bigToolResult(runs: string, output: string, extra: Record<string, unknown> = {}): number {
  const toolCall = { type: "tool_call", id: "c1", name: "toolbox_fake__echo", arguments: { text: "x" } }
  const call = { kind: "model_call", purpose: "chat", error: null, output: { parts: [toolCall] } }
  const step = { call_id: "c1", closed: null, is_error: false, kind: "tool_result", output, ...extra }
  const result = line(3, "node_step", { node_id: REPLY, n: 2n, step })
  const log = path.join(runs, RUN, "log.jsonl")
  fs.mkdirSync(path.dirname(log), { recursive: true })
  const head = [runStarted(0), started(1, REPLY), line(2, "node_step", { node_id: REPLY, n: 1n, step: call })]
  fs.writeFileSync(log, Buffer.concat([...head, result]))
  return result.length
}

test("a tool result over the line cap completes its tool part with its size", () => {
  const runs = tempDir()
  const size = bigToolResult(runs, "y".repeat(20_000))
  const transcript = new Transcript(runs, { lineCap: 16_384 })
  const read = messages(runs, newId(), [RUN], { transcript })
  expect(tools(read)).toEqual([["c1", "completed", tooLargeText(size), null]])
  expect(shown(read)).toEqual([["assistant", ["completed"]]])
})

test("a tool result over the line cap keeps its error or interruption", () => {
  const capped = (runs: string) =>
    messages(runs, newId(), [RUN], { transcript: new Transcript(runs, { lineCap: 16_384 }) })
  const errored = tempDir()
  const size = bigToolResult(errored, "y".repeat(20_000), { is_error: true })
  expect(tools(capped(errored))).toEqual([["c1", "error", {}, tooLargeText(size)]])
  const closed = tempDir()
  const cut = bigToolResult(closed, "y".repeat(20_000), { closed: "x" })
  expect(tools(capped(closed))).toEqual([["c1", "interrupted", {}, tooLargeText(cut)]])
})

test("a run end over the line cap ends the run, and another node's line over it is skipped", () => {
  const runs = tempDir()
  const log = path.join(runs, RUN, "log.jsonl")
  fs.mkdirSync(path.dirname(log), { recursive: true })
  const big = "z".repeat(20_000)
  const commit = line(2, "pool_commit", { node_id: "other", key: "other", kind: "object", value: { output: big } })
  fs.writeFileSync(log, Buffer.concat([runStarted(0), started(1, REPLY), commit]))
  const transcript = new Transcript(runs, { lineCap: 16_384 })
  expect(transcript.runningReply(RUN)).toBe(`${RUN}:${String(1).padStart(12, "0")}`)
  expect(messages(runs, newId(), [RUN], { transcript })).toEqual([])
  fs.appendFileSync(log, line(3, "run_failed", { failure: { code: "x", message: big } }))
  expect(transcript.runningReply(RUN)).toBeNull()
})

test("a line over the line cap that is not its seq stops the transcript, logged without its content", () => {
  const runs = tempDir()
  const log = path.join(runs, RUN, "log.jsonl")
  fs.mkdirSync(path.dirname(log), { recursive: true })
  const secret = "secret-looking-" + "q".repeat(20_000)
  const commit = line(5, "pool_commit", { node_id: "o", key: "o", kind: "object", value: { output: secret } })
  fs.writeFileSync(log, Buffer.concat([runStarted(0), started(1, REPLY), commit]))
  const logs: string[] = []
  const transcript = new Transcript(runs, { lineCap: 16_384, log: (text) => logs.push(text) })
  expect(transcript.messages(newId(), [RUN])).toEqual([])
  expect(transcript.runningReply(RUN)).toBe(`${RUN}:${String(1).padStart(12, "0")}`)
  expect(logs).toEqual([`run ${RUN}: the transcript stops after record 1 (RangeError: a line of its log can't be read)`])
})

test("a refresh yields to the event loop and leaves what a fresh read gives", async () => {
  const runs = tempDir()
  const log = path.join(runs, RUN, "log.jsonl")
  fs.mkdirSync(path.dirname(log), { recursive: true })
  const lines = [runStarted(0)]
  for (let seq = 1; seq < 20_000; seq++) lines.push(line(seq, "node_started", { node_id: `n${seq}` }))
  fs.writeFileSync(log, Buffer.concat(lines))
  const transcript = new Transcript(runs)
  let ticks = 0
  let ticking = true
  const tick = () => {
    ticks += 1
    if (ticking) setImmediate(tick)
  }
  setImmediate(tick)
  const sessionId = newId()
  await transcript.refresh([RUN])
  ticking = false
  expect(ticks).toBeGreaterThan(1)
  expect(transcript.messages(sessionId, [RUN])).toEqual(new Transcript(runs).messages(sessionId, [RUN]))
})

test("a read during a refresh shares its fold", async () => {
  const runs = tempDir()
  const { log } = await bigReply(runs)
  // Padded so the refresh takes more than one slice.
  const padding: Buffer[] = []
  let seq = [...iterRunRecords(log)].length
  for (let i = 0; i < 20_000; i++) padding.push(line(seq++, "node_started", { node_id: `pad${i}` }))
  const text = Buffer.concat(padding).toString().replaceAll(RUN, "r1")
  fs.appendFileSync(log, text)
  const transcript = new Transcript(runs)
  const sessionId = newId()
  const refreshing = transcript.refresh(["r1"])
  await new Promise((resolve) => setImmediate(resolve))
  const during = transcript.messages(sessionId, ["r1"])
  await refreshing
  const fresh = new Transcript(runs).messages(sessionId, ["r1"])
  expect(during).toEqual(fresh)
  expect(transcript.messages(sessionId, ["r1"])).toEqual(fresh)
})

test("a run forgotten during its refresh isn't kept", async () => {
  const runs = tempDir()
  const log = path.join(runs, RUN, "log.jsonl")
  fs.mkdirSync(path.dirname(log), { recursive: true })
  const lines = [runStarted(0)]
  for (let seq = 1; seq < 40_000; seq++) lines.push(line(seq, "node_started", { node_id: `n${seq}` }))
  fs.writeFileSync(log, Buffer.concat(lines))
  const logs: string[] = []
  const transcript = new Transcript(runs, { log: (text) => logs.push(text) })
  const refreshing = transcript.refresh([RUN])
  await new Promise((resolve) => setImmediate(resolve))
  transcript.forget([RUN])
  await refreshing
  // Nothing cached: a read starts from the log's first byte, and stops there.
  corrupt(log)
  expect(transcript.messages(newId(), [RUN])).toEqual([])
  expect(logs).toEqual([expect.stringMatching(/stops before its first record/)])
})

test("logs whose folds hold little stay cached however large the logs are", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "A." }, { content: "B." })
  const runs = tempDir()
  const pad = (log: string, runId: string) => {
    let seq = [...iterRunRecords(log)].length
    const big = "p".repeat(50_000)
    const lines: Buffer[] = []
    for (let i = 0; i < 4; i++) {
      lines.push(line(seq++, "pool_commit", { node_id: "other", key: `k${i}`, kind: "object", value: { output: big } }))
    }
    fs.appendFileSync(log, Buffer.concat(lines).toString().replaceAll(RUN, runId))
  }
  const a = await waitingChat(fake, "chat", {}, { runs, runId: "a" })
  await advance(a, fake, [send("s1", "to a")])
  pad(a.log, "a")
  const b = await waitingChat(fake, "chat", {}, { runs, runId: "b" })
  await advance(b, fake, [send("s2", "to b")])
  pad(b.log, "b")
  // Below either log, above both folds.
  const transcript = new Transcript(runs, { maxBytes: 150_000 })
  const sessionId = newId()
  expect(messages(runs, sessionId, ["a"], { transcript }).length).toBe(2)
  expect(messages(runs, sessionId, ["b"], { transcript }).length).toBe(2)
  corrupt(a.log)
  expect(texts(messages(runs, sessionId, ["a"], { transcript }))).toEqual([
    ["user", ["to a"]],
    ["assistant", ["A."]],
  ])
})

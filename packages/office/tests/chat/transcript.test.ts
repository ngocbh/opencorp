/** A session's transcript, read from its runs' logs (Python's `tests/chat/test_transcript.py`). */
import { expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { iterRunRecords, type LiveViewCall, type PoolCommitRecord, type RunLogEntry } from "@ngocbh/yian/run"
import { pending } from "@ngocbh/yian/tools"
import { Message, type ToolPart } from "@opencorp/protocol"
import { INTERRUPTED_TEXT, type LiveCalls, Transcript } from "../../src/chat/transcript.ts"
import { MAIN_CHAT } from "../../src/chat/turns.ts"
import { newId } from "../../src/store/store.ts"
import type { FakeLLM } from "../../src/testing/fake_llm.ts"
import type { Delivery, Job } from "../../src/worker/job.ts"
import { tempDir, waitFor } from "../helpers.ts"
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

/** A chat run whose reply calls `shell` three times and `search` once, its last shell call answering last; its job,
 *  run to waiting at the next turn under `runs` as `r1`. */
async function toolRun(runs: string): Promise<Job> {
  const fake = await fakeLlm()
  fake.script(
    {
      content: "",
      tool_calls: [
        { id: "c1", name: "shell", arguments: { command: "ls", count: 3 } },
        { id: "c2", name: "search", arguments: { pattern: "x" } },
        { id: "c3", name: "shell", arguments: { command: "sleep 9" } },
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
  fake.script({ content: "Trying.", tool_calls: [{ id: "bad", name: "shell", arguments: "{not json" }] })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  await advance(job, fake, [send("s1", "hi")])
  const call = steps(job.log).find((step) => step.kind === "model_call" && step.purpose === "chat")!
  const parts = (call.output as { parts: Step[] }).parts
  expect(parts.find((part) => part.type === "tool_call")).toEqual({
    type: "tool_call",
    id: "bad",
    name: "shell",
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
  expect(shown(read)).toEqual([
    ["user", ["one"]],
    ["assistant", ["Thinking " + INTERRUPTED_TEXT]],
    ["user", ["queued"]],
    ["assistant", ["Got it."]],
  ])
  expect(messages(runs, sessionId, ["r1"], { transcript })).toEqual(read)
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

test("a reply interrupted before it streamed text shows its cut call and the marker", async () => {
  const fake = await fakeLlm()
  const runs = tempDir()
  await interruptMidReply(fake, { content: "", tool_calls: [{ id: "c1", name: "toolbox_stub" }] }, { runs })
  const reply = messages(runs, newId(), ["r1"])[1]!
  expect(reply.role).toBe("assistant")
  expect(tools([reply])).toEqual([["c1", "interrupted", {}, "Not run: interrupted by the user."]])
  expect(shown([reply])).toEqual([["assistant", ["interrupted", "[interrupted]"]]])
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
  expect(() => new Transcript(runs).messages(sessionId, ["r1"])).toThrow()
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
  const transcript = new Transcript(runs, { maxBytes: 1 })
  const sessionId = newId()
  expect(messages(runs, sessionId, ["a"], { transcript }).length).toBe(2)
  expect(messages(runs, sessionId, ["b"], { transcript }).length).toBe(2)
  corrupt(a.log)
  expect(() => transcript.messages(sessionId, ["a"])).toThrow()
  corrupt(b.log)
  expect(texts(messages(runs, sessionId, ["b"], { transcript }))).toEqual([
    ["user", ["to b"]],
    ["assistant", ["B."]],
  ])
  transcript.forget(["b"])
  expect(() => transcript.messages(sessionId, ["b"])).toThrow()
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

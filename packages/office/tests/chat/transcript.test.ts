/** A session's transcript, read from its runs' logs (Python's `tests/chat/test_transcript.py`). */
import { expect, setDefaultTimeout, test } from "bun:test"
import { iterRunRecords, type PoolCommitRecord, type RunLogEntry } from "@ngocbh/yian/run"
import { pending } from "@ngocbh/yian/tools"
import { Message, type ToolPart } from "@opencorp/protocol"
import { INTERRUPTED_TEXT, Transcript } from "../../src/chat/transcript.ts"
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
  send,
  TemplateOffice,
  templateJob,
  waitingAt,
  waitingChat,
} from "./helpers.ts"

setDefaultTimeout(30_000)

/** The messages of the runs `runIds` under `runs`, each checked against the protocol's `Message`. */
function messages(runs: string, sessionId: string, runIds: string[]): Message[] {
  const read = new Transcript(runs).messages(sessionId, runIds)
  for (const message of read) Message.parse(message)
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

/** The step of each `node_step` record in the log `log`. */
function steps(log: string): Record<string, unknown>[] {
  return [...iterRunRecords(log, { kinds: ["node_step"] })].map(
    (entry) => (entry.envelope.record as unknown as { step: Record<string, unknown> }).step,
  )
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
      if (args.command === "sleep 9") await Bun.sleep(100)
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

test("a node that never called a model writes nothing", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "SUMMARY-OF-TURN-0" }, { content: "Hello." }, { content: "SUMMARY-OF-TURN-1" })
  const history = [0, 1, 2, 3, 4].map((k) => [
    { role: "user", parts: [{ type: "text", text: `u${k}`.padEnd(8000, "u") }] },
    { role: "assistant", parts: [{ type: "text", text: `a${k}`.padEnd(8000, "a") }] },
  ])
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", { history }, { runs })
  await advance(job, fake, [send("s1", "next")])
  expect(fake.requests().length).toBe(3)
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
  expect(shown(messages(runs, newId(), ["r1"]))).toEqual([
    ["user", ["one"]],
    ["assistant", ["Thinking " + INTERRUPTED_TEXT]],
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
  expect(shown(messages(runs, newId(), ["r1"]))).toEqual([
    ["user", ["Plan the trip."]],
    ["assistant", ["Working", "completed", "[interrupted]"]],
  ])
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

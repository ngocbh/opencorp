/** The company template's chat flows (Python's `tests/chat/test_template.py`). */
import { expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readFlow } from "../../src/company/flow_yaml.ts"
import { loadConfined } from "../../src/company/flows.ts"
import type { FakeLLM, ScriptedReply } from "../../src/testing/fake_llm.ts"
import type { Delivery, Job, JobInput } from "../../src/worker/job.ts"
import { tempDir, waitFor } from "../helpers.ts"
import { advanceJob, inProcessWorker, makeJob, Recorder, run, type TestWorker, waitsOf } from "../worker/helpers.ts"
import { fakeLlm } from "./helpers.ts"

setDefaultTimeout(30_000)

const ROOT = fileURLToPath(new URL("../../src/company_template/template/", import.meta.url))
const CHAT = path.join(ROOT, "shared", "flows", "chat.yaml")
const SIDE = path.join(ROOT, "shared", "flows", "side_chat.yaml")
const MANAGER = path.join(ROOT, "shared", "flows", "profile_manager.yaml")

function read(file: string): Record<string, any> {
  return readFlow(fs.readFileSync(file, "utf8")) as Record<string, any>
}

test("chat template loads", async () => {
  expect((await loadConfined(ROOT, CHAT)).name).toBe("chat")
})

test("chat template takes the person into the replys system prompt", () => {
  const flow = read(CHAT)
  expect(flow.input).toHaveProperty("person")
  const reply = flow.defs.turn.nodes.reply
  expect(reply.system_prompt.startsWith("You are ${person.name} (@${person.handle})")).toBe(true)
})

test.each([
  ["chat", CHAT],
  ["side_chat", SIDE],
])("chat templates say who the person is talking with [%s]", async (_name, file) => {
  const flow = read(file)
  const turn = flow.defs.turn
  const reply = turn.nodes.reply
  expect([flow.input.talking_to, turn.input.talking_to]).toEqual(["!str", "!str"])
  expect([reply.input.talking_to, turn.output.talking_to]).toEqual(["${input.talking_to}", "${input.talking_to}"])
  expect(flow.nodes.chat.input.talking_to).toBe("${input.talking_to}")
  expect(reply.system_prompt.split("\n")[0].endsWith("${person.reports_to} ${talking_to}")).toBe(true)
  expect((await loadConfined(ROOT, file)).name).toBe(flow.name)
})

test("every chat template takes its turns and steers from its messages inbox", () => {
  for (const file of [CHAT, SIDE, MANAGER]) {
    const flow = read(file)
    const turn = flow.defs.turn
    const reply = turn.nodes.reply
    expect([flow.input.messages, turn.input.messages, flow.nodes.chat.input.messages]).toEqual([
      "!Inbox(Message)",
      "!Inbox(Message)",
      "${input.messages}",
    ])
    expect(turn.nodes.heard).toEqual({ kind: "tool", tool_id: "take", input: { from: "${input.messages}", take: "all" } })
    expect([reply.steer_inbox, reply.output, reply.prompt]).toEqual([
      "${input.messages}",
      "Optional(str)",
      ["${history}", "${said}"],
    ])
    expect(flow.nodes.chat.while).toBe("not closed and turns < max_turns")
    expect([flow.input.summary, flow.input.history, flow.input.turns, flow.input.max_turns]).toEqual([
      "!str",
      "!list(list(Message))",
      "!int",
      "!int",
    ])
    expect(Object.keys(turn.nodes)).toEqual(["context", "heard", "route", "reply"])
    expect(flow.typedefs?.Msg).toBeUndefined()
    expect(flow.input).not.toHaveProperty("steers")
  }
})

test("the template ends no session by time and its chats have no loop cap", () => {
  expect(fs.readFileSync(path.join(ROOT, "company.yaml"), "utf8")).not.toContain("idle_end")
  for (const file of [CHAT, SIDE, MANAGER]) expect(fs.readFileSync(file, "utf8")).not.toContain("max:")
})

test("the template compacts history with yians compact history flow", () => {
  const yian = fileURLToPath(new URL("../../../yian/examples/compact_history.yaml", import.meta.url))
  expect(fs.readFileSync(path.join(ROOT, "shared", "flows", "compact_history.yaml"))).toEqual(fs.readFileSync(yian))
  expect(read(CHAT).uses.compact_history).toBe("compact_history")
})

// The flow contracts, each run in an in-process worker. A send after a worker's result is acked during the linger
// but never advanced, so no test races a send against the end of a run: messages go in while a model call is held,
// or into a waiting run through an advance job's deliveries.

const PERSON = { name: "Minh", handle: "minh", title: "Engineer", company: "Acme", reports_to: "" }
// The groups each template flow names; `ask_user` is the worker's own tool.
const GROUPS: Record<string, string[]> = {
  chat: ["toolbox", "workspace", "company"],
  side_chat: ["workspace", "work_items"],
  profile_manager: ["profile"],
}

/** Stringifies `value` as JSON, ints that arrive as bigint included. */
function json(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? Number(v) : v))
}

/** A user message saying `text`, from `author` when given. */
function message(text: string, author?: string): Record<string, unknown> {
  return { role: "user", parts: [{ type: "text", text }], ...(author === undefined ? {} : { author }) }
}

/** A send of `text` to the messages inbox. */
function send(id: string, text: string, author?: string): Delivery {
  return { id, op: "send", inbox: "messages", event: message(text, author) }
}

const CLOSE: Delivery = { id: "close", op: "close", inbox: "messages" }

const EMPTY = { type: "object", properties: {} }

/** A `Recorder` serving one no-op tool, `<group>_stub`, for each group `name`'s flow names. */
class Office extends Recorder {
  constructor(name = "chat") {
    super({
      tools: Object.fromEntries(
        GROUPS[name]!.map((group) => [
          group,
          { [`${group}_stub`]: { description: "Does nothing.", parameters: EMPTY, call: () => "ok" } },
        ]),
      ),
    })
  }
}

/** A chat job running the template flow `name` from a temp copy of the template; `inputs` replace the defaults. */
function templateJob(name: string, handlers: Recorder, inputs: Record<string, unknown> = {}): Job {
  const root = tempDir()
  const pin = path.join(root, "pin")
  fs.cpSync(ROOT, pin, { recursive: true })
  const who = name === "profile_manager" ? {} : { person: PERSON, talking_to: "" }
  const over: Partial<JobInput> = {
    inputs: { ...who, summary: "", history: [], turns: 0, max_turns: 500, ...inputs },
  }
  return makeJob({ pin, runs: path.join(root, "runs") }, `shared/flows/${name}.yaml`, over, handlers)
}

/** Advances the run `chat` started, applying `deliver` first; returns its recorder. */
function advance(chat: Job, fake: FakeLLM, deliver: Delivery[], name = "chat"): Promise<Recorder> {
  return run(advanceJob(chat, { deliver }), new Office(name), { env: fake.env() })
}

/** The nodes a waiting result waits at. */
function waitingAt(rec: Recorder): unknown[] {
  expect(rec.outcome?.status).toBe("waiting")
  return waitsOf(rec).map((wait) => wait.node)
}

/** The data of each NodeSucceeded event `rec` recorded for `node`. */
function succeeded(rec: Recorder, node: string): Record<string, any>[] {
  return rec.frames
    .filter((frame) => frame.name === "NodeSucceeded" && (frame.data as Record<string, unknown>).node_id === node)
    .map((frame) => frame.data as Record<string, any>)
}

/** Each message as its role and text: the text parts joined. */
function said(messages: Record<string, any>[]): [string, string][] {
  return messages.map((m) => [
    m.role,
    (m.parts as Record<string, any>[])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
  ])
}

/** The messages of the `index`th model request. */
function requestMessages(fake: FakeLLM, index: number): Record<string, any>[] {
  return fake.requests()[index]!.messages as Record<string, any>[]
}

/** Starts a chat job of `name` with no deliveries and runs it to waiting at its first take; returns the job. */
async function waitingChat(fake: FakeLLM, name = "chat", inputs: Record<string, unknown> = {}): Promise<Job> {
  const rec = new Office(name)
  const job = templateJob(name, rec, inputs)
  await run(job, rec, { env: fake.env() })
  expect(waitingAt(rec)).toEqual(["chat#0/heard"])
  return job
}

test("two messages sent before an advance are one turn", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hello both." })
  const job = await waitingChat(fake)
  expect(fake.requests()).toEqual([])
  const rec = await advance(job, fake, [send("s1", "one"), send("s2", "two")])
  expect(fake.requests().length).toBe(1)
  expect(requestMessages(fake, 0).slice(-2)).toEqual([
    { role: "user", content: "one" },
    { role: "user", content: "two" },
  ])
  expect(waitingAt(rec)).toEqual(["chat#1/heard"])
})

test("a message sent during the reply reaches its next model call and the history", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Looking.", tool_calls: [{ name: "toolbox_stub" }] }, { content: "Done." })
  const job = await waitingChat(fake)
  // The tool returns only once the worker has applied the send, so the reply's next model call reads it.
  class SendDuringTool extends Office {
    override async toolCall(worker: TestWorker, group: string, name: string, args: Record<string, unknown>) {
      await worker.deliver(send("during", "Also mention Rome."))
      await waitFor(() => this.replies.some((reply) => reply.id === "during"), { timeout: 10_000, what: "the reply" })
      return await super.toolCall(worker, group, name, args)
    }
  }
  const during = advanceJob(job, { deliver: [send("s1", "Plan the trip.")] })
  const rec = await run(during, new SendDuringTool(), { env: fake.env() })
  expect(fake.requests().length).toBe(2)
  expect(json(requestMessages(fake, 1))).toContain("Also mention Rome.")
  const [end] = succeeded(rec, "chat#0/__end__")
  expect(json(end!.output.history)).toContain("Also mention Rome.")
  expect(waitingAt(rec)).toEqual(["chat#1/heard"])
})

test("a message sent after the replys last model call is the next turn at once", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "First." }, { content: "Second." })
  const job = await waitingChat(fake)
  expect(waitingAt(await advance(job, fake, [send("s1", "one")]))).toEqual(["chat#1/heard"])
  // The linger case: a send that reaches a live run is taken by the same worker, so a send the reply never read
  // arrives as the next advance's delivery.
  const rec = await advance(job, fake, [send("s2", "two")])
  expect(fake.requests().length).toBe(2)
  expect(requestMessages(fake, 1).at(-1)).toEqual({ role: "user", content: "two" })
  expect(waitingAt(rec)).toEqual(["chat#2/heard"])
})

/** Holds the reply's first model call (answering `held`), sends "queued", interrupts, then releases; returns the
 *  recorder of that run, which answers "queued" as its next turn and waits at the one after. */
async function interruptMidReply(fake: FakeLLM, held: ScriptedReply): Promise<Recorder> {
  fake.script({ ...held, hold: true }, { content: "Got it." })
  const job = await waitingChat(fake)
  const cut = new Office()
  const worker = await inProcessWorker(advanceJob(job, { deliver: [send("s1", "one")] }), cut, { env: fake.env() })
  await fake.waitForRequests(1, 30_000)
  expect(await worker.deliver(send("queued", "queued"))).toBe(true)
  await waitFor(() => cut.replies.some((reply) => reply.id === "queued"), { timeout: 10_000, what: "the send" })
  expect(await worker.deliver({ id: "cut", op: "interrupt", inbox: "messages" })).toBe(true)
  await waitFor(() => cut.replies.some((reply) => reply.id === "cut"), { timeout: 10_000, what: "the interrupt" })
  fake.release()
  expect(await worker.wait()).not.toBeNull()
  // The queued message the cut reply never read is the next turn, taken by the same worker.
  expect(waitingAt(cut)).toEqual(["chat#2/heard"])
  return cut
}

test("an interrupt mid reply gives a null reply and the run waits at the next turn with the queued message", async () => {
  const fake = await fakeLlm()
  // Several chunks: the cut lands before a later one, since a reply whose text has all arrived stands.
  const cut = await interruptMidReply(fake, { content: "Thinking about it" })
  const [reply] = succeeded(cut, "chat#0/reply")
  expect([reply!.interrupted, reply!.output]).toEqual([true, null])
  expect(fake.requests().length).toBe(2)
  expect(requestMessages(fake, 1).at(-1)).toEqual({ role: "user", content: "queued" })
})

test("an interrupted reply with no text adds no empty assistant message to the next request", async () => {
  const fake = await fakeLlm()
  // A reply with no text and no tool call is a final answer, which stands; one that calls a tool is cut before the
  // call runs.
  const cut = await interruptMidReply(fake, { content: "", tool_calls: [{ name: "toolbox_stub" }] })
  expect(succeeded(cut, "chat#0/reply").map((reply) => [reply.interrupted, reply.output])).toEqual([[true, null]])
  expect(fake.requests().length).toBe(2)
  const assistants = requestMessages(fake, 1).filter((m) => m.role === "assistant")
  expect(assistants.filter((m) => !m.content && !m.tool_calls)).toEqual([])
})

test("the author of a message reaches the request", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hi." })
  const job = await waitingChat(fake)
  await advance(job, fake, [send("s1", "hello", "ngocbh")])
  const users = requestMessages(fake, 0).filter((m) => m.role === "user")
  expect(users.map((m) => String(m.content)).join("\n")).toContain('<authored_message author="ngocbh">')
})

test("one turn below max turns answers one turn with two messages queued then succeeds", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hello both." }, { content: "Unused." })
  const job = await waitingChat(fake, "chat", { turns: 4, max_turns: 5 })
  const rec = await advance(job, fake, [send("s1", "one"), send("s2", "two")])
  expect(fake.requests().length).toBe(1)
  expect(rec.outcome?.status).toBe("succeeded")
})

test.each([["chat"], ["side_chat"], ["profile_manager"]])(
  "a template chat ends when its inbox closes [%s]",
  async (name) => {
    const fake = await fakeLlm()
    fake.script({ content: "Hello." }, { content: "Unused." })
    const job = await waitingChat(fake, name)
    expect(waitingAt(await advance(job, fake, [send("s1", "hi")], name))).toEqual(["chat#1/heard"])
    const rec = await advance(job, fake, [CLOSE], name)
    expect(rec.outcome?.status).toBe("succeeded")
    expect(fake.requests().length).toBe(1)
    expect(said((rec.outcome?.output as Record<string, any>).history)).toEqual([
      ["user", "hi"],
      ["assistant", "Hello."],
    ])
  },
)

test("a message read along with the close is kept unanswered", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Unused." })
  const job = await waitingChat(fake)
  const rec = await advance(job, fake, [send("s1", "bye"), CLOSE])
  expect(fake.requests()).toEqual([])
  expect(rec.outcome?.status).toBe("succeeded")
  expect(said((rec.outcome?.output as Record<string, any>).history)).toEqual([["user", "bye"]])
})

test("a long history is folded into the summary before the reply", async () => {
  const fake = await fakeLlm()
  // The second turn starts over budget too, so it folds again beside its take.
  fake.script({ content: "SUMMARY-OF-TURN-0" }, { content: "Hello." }, { content: "SUMMARY-OF-TURN-1" })
  const turns = [0, 1, 2, 3, 4].map((k) => [
    { role: "user", parts: [{ type: "text", text: `u${k}`.padEnd(8000, "u") }] },
    { role: "assistant", parts: [{ type: "text", text: `a${k}`.padEnd(8000, "a") }] },
  ])
  const job = await waitingChat(fake, "chat", { history: turns })
  expect(fake.requests().length).toBe(1)
  const rec = await advance(job, fake, [send("s1", "next")])
  expect(waitingAt(rec)).toEqual(["chat#1/heard"])
  expect(fake.requests().length).toBe(3)
  const [summarise, reply] = [requestMessages(fake, 0), requestMessages(fake, 1)]
  expect(summarise[0]!.role).toBe("system")
  expect(String(summarise[0]!.content).startsWith("You keep a running summary")).toBe(true)
  expect(reply[0]!.role).toBe("system")
  expect(String(reply[0]!.content)).toContain("SUMMARY-OF-TURN-0")
  expect(reply.slice(1)).toEqual([
    ...turns.slice(1).flatMap(([user, assistant]) => [
      { role: "user", content: user!.parts[0]!.text },
      { role: "assistant", content: assistant!.parts[0]!.text },
    ]),
    { role: "user", content: "next" },
  ])
})

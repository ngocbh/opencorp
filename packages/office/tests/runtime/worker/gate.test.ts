/** The worker's `beforeToolCall` hook: each tool call of a chat or advance job's agents is one `gate_call` request to
 *  the office, whose answer runs it (with a note or not), refuses it or holds it; a request that fails refuses it. */
import path from "node:path"
import type { GatedCall } from "@ngocbh/yian"
import { inspectRun, iterRunRecords } from "@ngocbh/yian/run"
import { isPending, pending, ToolSet } from "@ngocbh/yian/tools"
import { expect, setDefaultTimeout, test } from "bun:test"
import { ChannelClosed, type Frame } from "../../../src/runtime/worker/channel.ts"
import { groupSpecs, type Job, toolSpec } from "../../../src/runtime/worker/job.ts"
import {
  answerRequest,
  BaseHandlers,
  GATE_FAILED,
  GATE_TIMEOUT_MS,
  gateHook,
  type OfficeTool,
  RemoteError,
  remoteTool,
  Rpc,
} from "../../../src/runtime/worker/rpc.ts"
import { fakeLlm } from "../../features/chat/helpers.ts"
import { waitFor } from "../../helpers.ts"
import {
  advanceJob,
  base,
  channelPair,
  inProcessWorker,
  makeJob,
  officeEnd,
  profileMemory,
  recordFrames,
  Recorder,
  run,
  waitsOf,
  workerFor,
  writeFiles,
} from "./helpers.ts"

setDefaultTimeout(30_000)

/** Yian's text for a call whose host check failed. */
const YIAN_GATE_FAILED = "The host's permission check failed; the call didn't run."

const SIGNAL = new AbortController().signal

/** An office tool that returns its text in capitals and counts its calls in `calls`. */
function shouting(calls: string[] = []): OfficeTool {
  return {
    description: "Return text in capitals.",
    parameters: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    call: ({ text }) => {
      calls.push(String(text))
      return String(text).toUpperCase()
    },
  }
}

/** A recorder that keeps each call the worker's hook asks about, and answers it with `decide`. */
class Gating extends Recorder {
  readonly gated: GatedCall[] = []

  constructor(
    readonly decide: (call: GatedCall) => unknown = () => undefined,
    options: ConstructorParameters<typeof Recorder>[0] = {},
  ) {
    super(options)
  }

  override gateCall(_worker: unknown, call: GatedCall): unknown {
    this.gated.push(call)
    return this.decide(call)
  }
}

/** One gated call of each source kind, as yian hands the hook one. */
const CALLS: GatedCall[] = [
  { kind: "host", group: "toolbox", tool: "shout" },
  { kind: "host", group: null, tool: "lookup" },
  { kind: "mcp", server: "github", tool: "create_issue" },
  { kind: "module", alias: "crm", ref: "./crm.ts", export: "quote" },
  { kind: "memory", input: "profile", tool: "read" },
  { kind: "flow", flow: "helper", library: null },
  { kind: "flow", flow: "quote", library: "billing" },
].map((source, i) => ({
  callId: `r1/reply/1/${i}`,
  node: "reply",
  tool: "tool_" + i,
  source: source as GatedCall["source"],
  arguments: { text: "hi", n: i, nested: { list: [1, "two", null] } },
  scopes: i % 2 === 0 ? [] : [{ scope: "outer/helper#0", callId: "r1/outer/1/0" }],
  attempt: 1 + (i % 3),
}))

test("the hook sends each call as one gate_call request, and the office gets it as yian gave it, of every source", async () => {
  const frames = recordFrames()
  const handlers = new Gating()
  const hook = gateHook(await officeEnd(handlers))
  for (const call of CALLS) expect(await hook(call, { runId: "r1", signal: SIGNAL })).toBeUndefined()
  // A flow's call names the module tools it calls; a hook with no reader of them sends them as unread.
  expect(handlers.gated).toEqual(CALLS.map((call) => (call.source.kind === "flow" ? { ...call, wraps: null } : call)))
  const sent = frames.map((frame) => JSON.parse(frame) as Frame).find((frame) => frame.type === "gate_call")
  expect(sent).toEqual({
    type: "gate_call",
    id: 1,
    call: {
      call_id: "r1/reply/1/0",
      node: "reply",
      tool: "tool_0",
      source: { kind: "host", group: "toolbox", tool: "shout" },
      arguments: { text: "hi", n: 0, nested: { list: [1, "two", null] } },
      scopes: [],
      attempt: 1,
    },
  })
})

test("the office's answers become yian's: run, run with a note, refuse and hold", async () => {
  const answers: unknown[] = [
    undefined, { run: true }, { run: true, note: "an allow rule" }, { refuse: "Not run." }, pending(),
  ]
  const handlers = new Gating(() => answers.shift())
  const hook = gateHook(await officeEnd(handlers))
  const ctx = { runId: "r1", signal: SIGNAL }
  expect(await hook(CALLS[0]!, ctx)).toBeUndefined()
  expect(await hook(CALLS[0]!, ctx)).toBeUndefined()
  expect(await hook(CALLS[0]!, ctx)).toEqual({ run: true, note: "an allow rule" })
  expect(await hook(CALLS[0]!, ctx)).toEqual({ refuse: "Not run." })
  expect(isPending(await hook(CALLS[0]!, ctx))).toBe(true)
})

test("each answer is one reply frame: run, its note, refuse or hold", async () => {
  const decided: unknown[] = [undefined, { run: true }, { run: true, note: "read-only" }, { refuse: "No." }, pending()]
  const handlers = new Gating(() => decided.shift())
  const worker = workerFor(handlers)
  const frame = { type: "gate_call", id: 4, call: wire(CALLS[2]!) }
  const replies = []
  for (let i = 0; i < 5; i++) replies.push(await answerRequest(frame, handlers, worker))
  expect(replies).toEqual([
    { type: "gate_decision", id: 4, run: true },
    { type: "gate_decision", id: 4, run: true },
    { type: "gate_decision", id: 4, run: true, note: "read-only" },
    { type: "gate_decision", id: 4, refuse: "No." },
    { type: "gate_decision", id: 4, hold: true },
  ])
})

test("the base handlers refuse every call: a host that doesn't gate its calls fails closed", async () => {
  const handlers = new BaseHandlers()
  const reply = await answerRequest({ type: "gate_call", id: 1, call: wire(CALLS[3]!) }, handlers, workerFor(handlers))
  expect(reply).toEqual({ type: "gate_decision", id: 1, refuse: "Not run: nothing here decides this session's calls." })
})

test("an office gate that throws or answers no decision is a failed reply of fixed text, so the hook throws", async () => {
  const bad: (() => unknown)[] = [
    () => {
      throw new Error("the rules can't be read")
    },
    () => ({ run: false }),
    () => ({ run: true, note: 5 }),
    () => ({ refuse: 5 }),
    () => ({ run: true, refuse: "both" }),
    () => "yes",
    () => null,
  ]
  for (const decide of bad) {
    const handlers = new Gating(decide)
    const frame = { type: "gate_call", id: 1, call: wire(CALLS[0]!) }
    const lines: string[] = []
    const reply = await answerRequest(frame, handlers, workerFor(handlers), { log: (_, line) => void lines.push(line) })
    // Yian's warning in the worker's log quotes the reply's text, so it never holds the office's own error.
    expect(reply).toEqual({ type: "gate_decision", id: 1, error: "failed", message: GATE_FAILED })
    expect(lines).toEqual([expect.stringMatching(/^worker gate_call request failed: (Error|TypeError)$/)])
    const hook = gateHook(await officeEnd(handlers))
    const error = await hook(CALLS[0]!, { runId: "r1", signal: SIGNAL }).then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(RemoteError)
    expect((error as Error).message).toBe(GATE_FAILED)
  }
})

test("a gate request the office doesn't answer in time makes the hook throw, so yian refuses the call", async () => {
  expect(GATE_TIMEOUT_MS).toBe(30_000)
  const handlers = new Gating(() => new Promise(() => {}))
  const hook = gateHook(await officeEnd(handlers), { timeoutMs: 50 })
  const error = await hook(CALLS[0]!, { runId: "r1", signal: SIGNAL }).then(() => null, (e: unknown) => e)
  expect((error as Error).name).toBe("TimeoutError")
  expect(handlers.gated).toHaveLength(1)
})

test("a late reply to a request that was given up is dropped, and never answers another call", async () => {
  const { office, worker } = await channelPair()
  const rpc = new Rpc(worker)
  void (async () => {
    for (;;) rpc.deliver(await worker.recv())
  })().catch(() => {})
  const hook = gateHook(rpc)
  const stop = new AbortController()
  const first = hook(CALLS[0]!, { runId: "r1", signal: stop.signal })
  const given = await office.recv()
  stop.abort(new Error("the node stopped"))
  expect(await first.then(() => null, (e: unknown) => e)).toEqual(new Error("the node stopped"))
  const second = hook(CALLS[1]!, { runId: "r1", signal: SIGNAL })
  const asked = await office.recv()
  expect(asked.id).not.toBe(given.id)
  await office.send({ type: "gate_decision", id: given.id, refuse: "Late." })
  await office.send({ type: "gate_decision", id: asked.id, run: true })
  expect(await second).toBeUndefined()
})

test("a reply that isn't a decision, a closed channel and an aborted request all make the hook throw", async () => {
  const { office, worker } = await channelPair()
  const rpc = new Rpc(worker)
  void (async () => {
    for (;;) {
      const frame = await worker.recv()
      rpc.deliver(frame)
    }
  })().catch(() => {})
  const hook = gateHook(rpc)
  const replies: Frame[] = [
    { type: "tool_result", run: true },
    { type: "answer", hold: true },
    { type: "gate_decision", hold: false },
    { type: "gate_decision", run: true, note: null },
    { type: "gate_decision", run: true, extra: 1 },
    { type: "gate_decision", refuse: "x", hold: true },
    { type: "gate_decision" },
  ]
  for (const reply of replies) {
    const decided = hook(CALLS[0]!, { runId: "r1", signal: SIGNAL })
    const request = await office.recv()
    await office.send({ ...reply, id: request.id })
    expect(await decided.then(() => null, (e: unknown) => e)).toBeInstanceOf(TypeError)
  }
  const stop = new AbortController()
  const stopped = hook(CALLS[0]!, { runId: "r1", signal: stop.signal })
  await office.recv()
  stop.abort(new Error("the node stopped"))
  expect(await stopped.then(() => null, (e: unknown) => e)).toEqual(new Error("the node stopped"))
  rpc.close(new ChannelClosed())
  expect(await hook(CALLS[0]!, { runId: "r1", signal: SIGNAL }).then(() => null, (e: unknown) => e)).toBeInstanceOf(
    ChannelClosed,
  )
})

test("a gate request whose call isn't this run's, or is malformed, is refused before the office decides", async () => {
  const handlers = new Gating()
  const worker = workerFor(handlers)
  const forged = { type: "gate_call", id: 1, call: wire({ ...CALLS[0]!, callId: "r2/x/1/0" }) }
  const other = await answerRequest(forged, handlers, worker)
  expect([other.error, other.message]).toEqual(["failed", "gate_call request's call_id is not this run's"])
  const malformed: Frame[] = [
    {},
    { call: "x" },
    { call: { ...wire(CALLS[0]!), source: { kind: "host", tool: "shout" } } },
    { call: { ...wire(CALLS[0]!), source: { kind: "shell", tool: "x" } } },
    { call: { ...wire(CALLS[0]!), attempt: 0 } },
    { call: { ...wire(CALLS[0]!), arguments: [1] } },
    { call: { ...wire(CALLS[0]!), scopes: [{ scope: "s" }] } },
    { call: { ...wire(CALLS[0]!), extra: true } },
  ]
  for (const fields of malformed) {
    const reply = await answerRequest({ type: "gate_call", id: 2, ...fields }, handlers, worker)
    expect(reply.error).toBe("failed")
    expect(String(reply.message)).toStartWith("gate_call request")
  }
  expect(handlers.gated).toEqual([])
})

test("the hook and a remote tool share one channel, each request answered by its own reply", async () => {
  const frames = recordFrames()
  const calls: string[] = []
  const served = { toolbox: { shout: shouting(calls) } }
  const handlers = new Gating(() => ({ run: true, note: "read-only" }), { tools: served })
  const rpc = await officeEnd(handlers)
  const hook = gateHook(rpc)
  const tools = new ToolSet({ toolbox: [remoteTool(rpc, "toolbox", toolSpec("shout", shouting()))] })
  expect(await hook(CALLS[0]!, { runId: "r1", signal: SIGNAL })).toEqual({ run: true, note: "read-only" })
  expect(await tools.invoke("shout", { text: "hi" }, { callId: "r1/reply/1/0" })).toBe("HI")
  // In process, each frame is recorded twice: as one end sends it and as the other reads it.
  const sent = frames.map((frame) => JSON.parse(frame) as Frame)
  const requests = sent.filter((frame) => frame.type === "gate_call" || frame.type === "tool_call")
  expect(requests.map((frame) => [frame.type, frame.id])).toEqual([
    ["gate_call", 1],
    ["gate_call", 1],
    ["tool_call", 2],
    ["tool_call", 2],
  ])
  expect(calls).toEqual(["hi"])
})

// --- a worker's runs ---------------------------------------------------------------------------------------------

/** An agent granted a tool group, a group's lone tool, a memory's read tool, a flow, `ask_user` and a skill. */
const GATED =
  "id: gated\nname: gated\ninput:\n  profile: !FileMemory\n  message: !str\ndefs:\n  helper:\n" +
  "    description: Shout a text back in capitals.\n    input:\n      text: !str\n    nodes:\n      loud:\n" +
  "        kind: code\n        input:\n          text: ${input.text}\n        output: !str\n" +
  "        code: return inputs.text.toUpperCase()\n    output: ${loud.output}\nnodes:\n  reply:\n    kind: agent\n" +
  "    tools: [toolbox, lookup, {profile: [read]}, helper, ask_user]\n    skills: [checklist]\n    input:\n" +
  '      message: ${input.message}\n    output: !str\n    prompt: "${message}"\noutput: ${reply.output}\n'

/** The worker tests' pin with the gated flow and minh's `checklist` skill. */
function gatedBase(): ReturnType<typeof base> {
  const where = base()
  writeFiles(where.pin, {
    "flows/gated.yaml": GATED,
    "people/minh/skills/checklist/SKILL.md": "---\ndescription: What to check.\n---\nCheck everything twice.\n",
  })
  return where
}

/** The `run_started` and `run_resumed` records of `job`'s log, each as `[kind, gated]`. */
function gatedRecords(job: Job): [string, unknown][] {
  return [...iterRunRecords(job.log, { kinds: ["run_started", "run_resumed"] })].map((entry) => [
    entry.kind,
    (entry.envelope!.record as unknown as { gated: boolean }).gated,
  ])
}

test("every tool source of a chat run reaches the office's gate, and ask_user and load_skill don't", async () => {
  const fake = await fakeLlm()
  fake.script(
    {
      content: "",
      tool_calls: [
        { name: "toolbox_shout", arguments: { text: "hi" } },
        { name: "lookup", arguments: { text: "x" } },
        { name: "profile_read", arguments: { path: "profile.md" } },
        { name: "helper", arguments: { text: "hey" } },
        { name: "ask_user", arguments: { question: "Where?" } },
        { name: "load_skill", arguments: { name: "checklist" } },
      ],
    },
    { content: "done" },
  )
  const where = gatedBase()
  const memories = { profile: profileMemory(path.join(where.root, "memory"), "# Minh\n") }
  const tools = { toolbox: { shout: shouting() }, lookup: { lookup: shouting() } }
  const rec = new Gating(() => undefined, { tools, memories, answers: ["Paris"] })
  const job = makeJob(where, "flows/gated.yaml", { skills: ["checklist"] }, rec)
  await run(job, rec, { env: fake.env() })
  expect([rec.outcome?.status, rec.outcome?.output], String(rec.outcome?.message)).toEqual(["succeeded", "done"])
  const seen = rec.gated.map(({ tool, source, arguments: args, scopes, attempt, node }) => ({
    tool, source, args, scopes, attempt, node,
  }))
  const call = { scopes: [], attempt: 1, node: "reply" }
  expect(seen.sort((a, b) => a.tool.localeCompare(b.tool))).toEqual([
    { ...call, tool: "helper", source: { kind: "flow", flow: "helper", library: null }, args: { text: "hey" } },
    { ...call, tool: "lookup", source: { kind: "host", group: null, tool: "lookup" }, args: { text: "x" } },
    {
      ...call,
      tool: "profile_read",
      source: { kind: "memory", input: "profile", tool: "read" },
      args: { path: "profile.md" },
    },
    { ...call, tool: "toolbox_shout", source: { kind: "host", group: "toolbox", tool: "shout" }, args: { text: "hi" } },
  ])
  expect(rec.gated.every((gated) => gated.callId.startsWith("r1/reply/1/"))).toBe(true)
  expect(rec.asked.map((request) => request.question)).toEqual(["Where?"])
  const results = JSON.stringify(fake.requests()[1]!.messages)
  for (const text of ["HI", "X", "# Minh", "HEY", "Paris", "Check everything twice."]) expect(results).toContain(text)
  expect(gatedRecords(job)).toEqual([["run_started", true]])
})

/** A company tool module: one tool, `quote`, that says the amount it quoted and whether it was handed an office
 *  context. */
const CRM = `export const quote = {
  name: "quote",
  description: "Quote a price.",
  parameters: { type: "object", properties: { amount: { type: "integer" } }, required: ["amount"] },
  execute: async (args, ctx) => \`quoted \${args.amount}; context \${ctx?.context === undefined ? "none" : "given"}\`,
}
`

/** A flow that calls the module's tool itself (`priced`), then has its agent, granted the module, reply. */
const MODULED =
  "id: moduled\nname: moduled\ninput:\n  message: !str\nuses:\n  crm: ./crm.ts\nnodes:\n  priced:\n" +
  "    kind: call\n    call: {crm: quote}\n    input:\n      amount: 3\n  reply:\n    kind: agent\n    tools: [crm]\n" +
  '    input:\n      message: ${input.message}\n      priced: ${priced.output}\n    output: !str\n' +
  '    prompt: "${message} ${priced}"\noutput: ${reply.output}\n'

test("a tool module's tool: an agent's call reaches the gate as a module call, the flow's own call runs ungated, and neither gets an office context", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "", tool_calls: [{ name: "crm_quote", arguments: { amount: 5 } }] }, { content: "done" })
  const where = base()
  writeFiles(where.pin, { "flows/moduled.yaml": MODULED, "flows/crm.ts": CRM })
  const rec = new Gating(() => undefined)
  const job = makeJob(where, "flows/moduled.yaml", {}, rec)
  await run(job, rec, { env: fake.env() })
  expect([rec.outcome?.status, rec.outcome?.output], String(rec.outcome?.message)).toEqual(["succeeded", "done"])
  // Only the agent's call is gated, as a module's tool.
  expect(rec.gated.map(({ tool, source, arguments: args }) => ({ tool, source, args }))).toMatchObject([
    { tool: "crm_quote", source: { kind: "module", alias: "crm", ref: "./crm.ts" }, args: { amount: 5n } },
  ])
  // The flow's own call ran before the agent's, with no gate; neither saw an office context.
  const asked = JSON.stringify(fake.requests().map((r) => r.messages))
  expect(asked).toContain("quoted 3; context none")
  expect(asked).toContain("quoted 5; context none")
})

/** A flow whose agent is granted `priced` (which calls the module's `quote` itself, then `inner`, which maps it, and
 *  the one-export alias `tally`) and `plain` (which calls no module tool). */
const WRAPPING =
  "id: wrapping\nname: wrapping\ninput:\n  message: !str\nuses:\n  crm: ./crm.ts\n  tally: ./tally.ts:tally\ndefs:\n" +
  "  inner:\n    description: Price each.\n    input:\n      amount: !int\n    nodes:\n      each:\n        kind: map\n" +
  "        over: ${[input.amount, input.amount]}\n        call: {crm: quote}\n        input:\n          amount: ${item}\n" +
  "      counted:\n        kind: call\n        call: tally\n        input:\n          n: ${input.amount}\n" +
  "    output: ${counted.output}\n" +
  "  priced:\n    description: Price an order.\n    input:\n      amount: !int\n    nodes:\n      first:\n" +
  "        kind: call\n        call: {crm: quote}\n        input:\n          amount: ${input.amount}\n      again:\n" +
  "        kind: call\n        call: inner\n        input:\n          amount: ${input.amount}\n    output: ${again.output}\n" +
  "  plain:\n    description: Say it loud.\n    input:\n      text: !str\n    nodes:\n      loud:\n        kind: code\n" +
  "        input:\n          text: ${input.text}\n        output: !str\n        code: return inputs.text.toUpperCase()\n" +
  "    output: ${loud.output}\n" +
  "nodes:\n  reply:\n    kind: agent\n    tools: [priced, plain]\n    input:\n      message: ${input.message}\n" +
  '    output: !str\n    prompt: "${message}"\noutput: ${reply.output}\n'

/** A one-export module: `tally` counts. */
const TALLY = `export const tally = {
  name: "tally",
  description: "Count.",
  parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
  execute: async (args) => \`counted \${args.n}\`,
}
`

test("a granted flow's call reaches the gate naming the module tools its steps call, through nested flows and maps", async () => {
  const fake = await fakeLlm()
  fake.script(
    {
      content: "",
      tool_calls: [{ name: "priced", arguments: { amount: 2 } }, { name: "plain", arguments: { text: "hi" } }],
    },
    { content: "done" },
  )
  const where = base()
  writeFiles(where.pin, { "flows/wrapping.yaml": WRAPPING, "flows/crm.ts": CRM, "flows/tally.ts": TALLY })
  const rec = new Gating(() => undefined)
  const job = makeJob(where, "flows/wrapping.yaml", {}, rec)
  await run(job, rec, { env: fake.env() })
  expect([rec.outcome?.status, rec.outcome?.output], String(rec.outcome?.message)).toEqual(["succeeded", "done"])
  const seen = rec.gated.map((call) => [call.tool, (call as { wraps?: unknown }).wraps])
  expect(seen.sort()).toEqual([
    ["plain", []],
    ["priced", [{ alias: "crm", export: "quote" }, { alias: "tally", export: "tally" }]],
  ])
  // The calls ran: the flow's own calls of the module, ungated.
  expect(JSON.stringify(fake.requests()[1]!.messages)).toContain("counted 2")
})

/** A module of four tools, each a flow below reaches another way. */
const OPS = `const tool = (name, properties, execute) => ({
  name, description: name, parameters: { type: "object", properties, required: Object.keys(properties) }, execute,
})
export const step = tool("step", { n: { type: "integer" } }, async (args) => ({ n: args.n + 1 }))
export const rate = tool("rate", { x: { type: "integer" } }, async (args) => \`rated \${args.x}\`)
export const price = tool("price", { amount: { type: "integer" } }, async (args) => \`priced \${args.amount}\`)
export const tag = tool("tag", { t: { type: "string" } }, async (args) => \`tagged \${args.t}\`)
`

/** Flows that reach the module's tools through a loop (`looped`), a lifted `call(...)` (`lifted`), a library's def
 *  (`billing.price`) and a child file (`tagging`), all granted to the agent. */
const REACHING =
  "id: reaching\nname: reaching\ninput:\n  message: !str\nuses:\n  ops: ./ops.ts\n  billing: billing\n  tagging: tagging\n" +
  "defs:\n  looped:\n    description: Count up.\n    input:\n      n: !int\n    nodes:\n      counted:\n        kind: loop\n" +
  "        call: {ops: step}\n        input:\n          n: ${input.n}\n        while: n < 2\n    output: ${counted.output.n}\n" +
  "  lifted:\n    description: Rate it.\n    input:\n      x: !int\n    nodes:\n      said:\n        kind: code\n" +
  "        input:\n          rated: call(ops.rate, x=${input.x})\n        output: !str\n        code: return String(inputs.rated)\n" +
  "    output: ${said.output}\n" +
  "nodes:\n  reply:\n    kind: agent\n    tools: [looped, lifted, billing, tagging]\n    input:\n      message: ${input.message}\n" +
  '    output: !str\n    prompt: "${message}"\noutput: ${reply.output}\n'
const BILLING =
  "id: billing\nname: billing\nuses:\n  ops: ./ops.ts\ndefs:\n  price:\n    description: Price it.\n    input:\n" +
  "      amount: !int\n    nodes:\n      priced:\n        kind: call\n        call: {ops: price}\n        input:\n" +
  "          amount: ${input.amount}\n    output: ${priced.output}\n"
const TAGGING =
  "id: tagging\nname: tagging\ndescription: Tag it.\ninput:\n  t: !str\nuses:\n  ops: ./ops.ts\nnodes:\n  tagged:\n" +
  "    kind: call\n    call: {ops: tag}\n    input:\n      t: ${input.t}\noutput: ${tagged.output}\n"

// Drift guards. The module tools a granted flow calls are read through yian's static graph with node methods yian
// doesn't document yet (`toolModules()`, `hostToolCall()`; yian#1823 asks for the documented API). Were a yian change to
// make them return nothing rather than throw, the gate's rule would fail open: each way a flow reaches a module tool
// is pinned here as listed.
test("a granted flow's module tools are listed whether it reaches them by a loop, a lifted call, a library's def or a child file", async () => {
  const fake = await fakeLlm()
  fake.script(
    {
      content: "",
      tool_calls: [
        { name: "looped", arguments: { n: 0 } },
        { name: "lifted", arguments: { x: 1 } },
        { name: "billing_price", arguments: { amount: 2 } },
        { name: "tagging", arguments: { t: "a" } },
      ],
    },
    { content: "done" },
  )
  const where = base()
  writeFiles(where.pin, {
    "flows/reaching.yaml": REACHING, "flows/billing.yaml": BILLING, "flows/tagging.yaml": TAGGING, "flows/ops.ts": OPS,
  })
  const rec = new Gating(() => undefined)
  const job = makeJob(where, "flows/reaching.yaml", {}, rec)
  await run(job, rec, { env: fake.env() })
  expect([rec.outcome?.status, rec.outcome?.output], String(rec.outcome?.message)).toEqual(["succeeded", "done"])
  const seen = Object.fromEntries(rec.gated.map((call) => [call.tool, (call as { wraps?: unknown }).wraps]))
  expect(seen).toEqual({
    looped: [{ alias: "ops", export: "step" }],
    lifted: [{ alias: "ops", export: "rate" }],
    billing_price: [{ alias: "ops", export: "price" }],
    tagging: [{ alias: "ops", export: "tag" }],
  })
  const read = JSON.stringify(fake.requests()[1]!.messages)
  for (const text of ["rated 1", "priced 2", "tagged a"]) expect(read).toContain(text)
})

test("the office's answer runs a call with its note, refuses it, and a gate that fails refuses it", async () => {
  const fake = await fakeLlm()
  fake.script(
    {
      content: "",
      tool_calls: ["a", "b", "c"].map((text) => ({ name: "toolbox_shout", arguments: { text } })),
    },
    { content: "done" },
  )
  const calls: string[] = []
  const decide = (call: GatedCall) => {
    const text = call.arguments.text
    if (text === "a") return { run: true, note: "an allow rule" }
    if (text === "b") return { refuse: "Not run: a deny rule: shout b." }
    throw new Error("the rules can't be read")
  }
  const rec = new Gating(decide, { tools: { toolbox: { shout: shouting(calls) } } })
  const job = makeJob(base(), "flows/tools.yaml", {}, rec)
  await run(job, rec, { env: fake.env() })
  expect([rec.outcome?.status, rec.outcome?.output], String(rec.outcome?.message)).toEqual(["succeeded", "done"])
  expect(rec.gated.map((call) => call.arguments.text)).toEqual(["a", "b", "c"])
  expect(calls).toEqual(["a"])
  const results = JSON.stringify(fake.requests()[1]!.messages)
  for (const text of ['"A"', "Not run: a deny rule: shout b.", YIAN_GATE_FAILED]) expect(results).toContain(text)
  // The note is kept in the log for audit; the model never reads it.
  expect(results).not.toContain("an allow rule")
  const notes = toolSteps(job).map((step) => [step.note ?? null, step.closed ?? null])
  expect(notes).toContainEqual(["an allow rule", null])
  expect(notes).toContainEqual([null, "refused"])
})

test("a held call waits, marked held; a release delivery runs it once, and the advance asks about the next call", async () => {
  const fake = await fakeLlm()
  fake.script(
    { content: "", tool_calls: [{ name: "toolbox_shout", arguments: { text: "first" } }] },
    { content: "", tool_calls: [{ name: "toolbox_shout", arguments: { text: "second" } }] },
    { content: "done" },
  )
  const calls: string[] = []
  const tools = { toolbox: { shout: shouting(calls) } }
  const holding = new Gating(() => pending(), { tools })
  const chat = makeJob(base(), "flows/tools.yaml", {}, holding)
  await run(chat, holding, { env: fake.env() })
  expect(holding.outcome?.status, String(holding.outcome?.message)).toBe("waiting")
  const held = holding.gated[0]!
  expect(waitsOf(holding)).toEqual([
    expect.objectContaining({ node: "reply", call_id: held.callId, held: true, settled: false }),
  ])
  expect(calls).toEqual([])
  const rec = new Gating(() => ({ run: true }), { tools })
  const release = { id: "r1", op: "release", call_id: held.callId, note: "approved by @ceo" } as const
  await run(advanceJob(chat, { deliver: [release] }), rec, { env: fake.env() })
  expect([rec.outcome?.status, rec.outcome?.output], String(rec.outcome?.message)).toEqual(["succeeded", "done"])
  expect(rec.replies).toEqual([{ type: "deliver_reply", id: "r1", seq: expect.any(Number) }])
  // The released call isn't asked about again; the next one is.
  expect(rec.gated.map((call) => call.arguments.text)).toEqual(["second"])
  expect(calls).toEqual(["first", "second"])
  expect(gatedRecords(chat)[0]).toEqual(["run_started", true])
  expect(toolSteps(chat).some((step) => step.note === "approved by @ceo")).toBe(true)
})

test("a gated run that a stop cut off is marked gated again when an advance resumes it", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "", tool_calls: [{ name: "toolbox_shout", arguments: { text: "hi" } }] }, { content: "done" })
  let called = false
  const hanging: OfficeTool = {
    ...shouting(),
    call: () => {
      called = true
      return new Promise(() => {})
    },
  }
  const first = new Gating(() => undefined, { tools: { toolbox: { shout: hanging } } })
  const chat = makeJob(base(), "flows/tools.yaml", {}, first)
  const worker = await inProcessWorker(chat, first, { env: fake.env() })
  await waitFor(() => called, { timeout: 10_000, what: "the tool call" })
  expect(await worker.stop()).toBe(true)
  await worker.wait()
  expect(inspectRun(chat.log).status).toBe("stopped")
  const rec = new Gating(() => undefined, { tools: { toolbox: { shout: shouting() } } })
  await run(advanceJob(chat), rec, { env: fake.env() })
  expect([rec.outcome?.status, rec.outcome?.output], String(rec.outcome?.message)).toEqual(["succeeded", "done"])
  expect(gatedRecords(chat)).toEqual([
    ["run_started", true],
    ["run_resumed", true],
  ])
})

test("a held call that a complete answers never runs, and a release of it after is refused", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "", tool_calls: [{ name: "toolbox_shout", arguments: { text: "hi" } }] }, { content: "ok" })
  const calls: string[] = []
  const tools = { toolbox: { shout: shouting(calls) } }
  const holding = new Gating(() => pending(), { tools })
  const chat = makeJob(base(), "flows/tools.yaml", {}, holding)
  await run(chat, holding, { env: fake.env() })
  expect(holding.outcome?.status, String(holding.outcome?.message)).toBe("waiting")
  const callId = holding.gated[0]!.callId
  const rec = new Gating(() => undefined, { tools })
  const deliver = [
    { id: "c1", op: "complete", call_id: callId, result: { output: "Not run: the user said no." } },
    { id: "r1", op: "release", call_id: callId },
  ] as const
  await run(advanceJob(chat, { deliver: [...deliver] }), rec, { env: fake.env() })
  expect([rec.outcome?.status, rec.outcome?.output], String(rec.outcome?.message)).toEqual(["succeeded", "ok"])
  expect(rec.replies).toEqual([
    { type: "deliver_reply", id: "c1", seq: expect.any(Number) },
    { type: "deliver_reply", id: "r1", refused: "call_settled" },
  ])
  expect(calls).toEqual([])
  expect(JSON.stringify(fake.requests()[1]!.messages)).toContain("Not run: the user said no.")
})

test("a group served as remote tools reaches the gate under the group's name", async () => {
  // A unit check of jobTools' shape: a group of two keeps its name, a group whose lone tool shares it is top-level.
  const fake = await fakeLlm()
  fake.script(
    { content: "", tool_calls: [{ name: "toolbox_whisper", arguments: { text: "a" } }] },
    { content: "done" },
  )
  const rec = new Gating(() => undefined, { tools: { toolbox: { shout: shouting(), whisper: shouting() } } })
  const job = makeJob(base(), "flows/tools.yaml", { groups: groupSpecs(rec.tools) })
  await run(job, rec, { env: fake.env() })
  expect(rec.gated.map((call) => call.source)).toEqual([{ kind: "host", group: "toolbox", tool: "whisper" }])
})

/** `call`'s wire form, as the hook sends it. */
function wire(call: GatedCall): Frame {
  return {
    call_id: call.callId,
    node: call.node,
    tool: call.tool,
    source: call.source,
    arguments: call.arguments,
    scopes: call.scopes.map(({ scope, callId }) => ({ scope, call_id: callId })),
    attempt: call.attempt,
  }
}

/** Each step of `job`'s log, and each result a step holds, as its fields: where a gate's note or refusal is kept. */
function toolSteps(job: Job): Record<string, unknown>[] {
  return [...iterRunRecords(job.log, { kinds: ["node_step"] })].flatMap((entry) => {
    const step = (entry.envelope!.record as unknown as { step: Record<string, unknown> }).step
    return [step, ...((Array.isArray(step.results) ? step.results : []) as Record<string, unknown>[])]
  })
}

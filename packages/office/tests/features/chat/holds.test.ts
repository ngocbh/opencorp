/** A chat's gate on its employee's tool calls: what the session's mode and rules let run, refuse or hold; the card a
 *  held call gets once yian holds it; Auto's check on what no reader can judge; and what Yes, No, Esc and a new rule
 *  do to a held call. The run's worker is scripted: these tests drive its gate calls and events. */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { stringify } from "yaml"
import type { GatedCall, ToolSource } from "@ngocbh/yian/tools"
import { isPending } from "@ngocbh/yian/tools"
import type { CheckRunner } from "../../../src/runtime/permissions/classifier.ts"
import type { CheckInput, Mode } from "../../../src/runtime/permissions/policy.ts"
import { sessionOption, YES } from "../../../src/runtime/questions/approval.ts"
import type { Delivery } from "../../../src/runtime/worker/job.ts"
import type { OfficeTool } from "../../../src/runtime/worker/rpc.ts"
import type { ScriptedReply } from "../../../src/testing/fake_llm.ts"
import { git } from "../../company/helpers.ts"
import { CEO } from "../../server/helpers.ts"
import { waitFor } from "../../helpers.ts"
import {
  chatOffice, fakeLlm, makeActor, makeHarness, newSession, noWorkersLeft, running, scriptedWorker, status, texts,
} from "./helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

const MCP: ToolSource = { kind: "mcp", server: "github", tool: "create_issue" }
const MODULE: ToolSource = { kind: "module", alias: "crm", ref: "./crm.ts", export: "quote" }
const START: ToolSource = { kind: "host", group: "codex", tool: "start" }

/** Auto's check's verdict on each call it judges, by the call's text: run unless `asks` names it. */
function fakeCheck(asks: string[] = []): { runCheck: CheckRunner; judged: CheckInput[] } {
  const judged: CheckInput[] = []
  const runCheck: CheckRunner = async (input) => {
    judged.push(input)
    const ask = asks.some((text) => input.command.includes(text))
    return { output: ask ? { verdict: "ask", reason: "it posts data" } : { verdict: "run", reason: "it only reads" } }
  }
  return { runCheck, judged }
}

/**
 * A chat in `mode` on scripted workers, with `rules` (`[effect, pattern]`, each a tool rule) in the company's
 * rules.yaml, `agent` in minh's, and `runCheck` as Auto's check; its run started. `gate` asks the run's gate about a
 * call of `source`, the `n`th of the reply; `held` sends the `CallHeld` yian sends once it holds that call;
 * `delivered` waits for a delivery of `op` on the call and returns it.
 */
async function gated(
  mode: Mode,
  {
    rules = [],
    agent = [],
    runCheck,
  }: { rules?: [string, string][]; agent?: [string, string][]; runCheck?: CheckRunner } = {},
) {
  const fake = await fakeLlm()
  const yaml = (list: [string, string][]) =>
    stringify({ rules: list.map(([effect, pattern]) => ({ effect, kind: "tool", pattern })) })
  const files = { "rules.yaml": yaml(rules), "people/minh/rules.yaml": yaml(agent) }
  const o = await chatOffice(fake, { files })
  const workers = scriptedWorker(o)
  const sid = await newSession(o, { openedBy: CEO })
  o.office.store.updateSession(sid, { mode })
  const actor = makeActor(o, sid, runCheck === undefined ? {} : { runCheck })
  await actor.start()
  const runId = actor.runId!
  const { worker, handlers, deliveries } = workers[0]!
  const callId = (n: number) => `${runId}/chat#0/reply/1/${n}`
  const gate = (source: ToolSource, n = 0, args: GatedCall["arguments"] = { title: "Fix" }) => {
    const call: GatedCall = {
      callId: callId(n), node: "chat#0/reply", tool: `tool_${n}`, source, arguments: args, scopes: [], attempt: 1,
    }
    return handlers.gateCall(worker, call)
  }
  const held = (n = 0) =>
    handlers.event(worker, {
      type: "event",
      name: "CallHeld",
      data: { node_id: "chat#0/reply", call_id: callId(n), tool: `tool_${n}` },
    })
  const delivered = async (op: Delivery["op"], n = 0): Promise<Delivery> =>
    await waitFor(() => deliveries.find((d) => d.op === op && "call_id" in d && d.call_id === callId(n)), {
      what: `a ${op} of call ${n}`,
    })
  const cards = () => o.office.store.listQuestions({ sessionId: sid, source: "approval" })
  const card = (n = 0) => o.office.store.getQuestionByCall(callId(n))
  return { o, sid, actor, runId, worker, handlers, deliveries, callId, gate, held, delivered, cards, card }
}

test("a call its row or a rule decides runs, with its note, or is refused, and no card is made", async () => {
  const g = await gated("default", { rules: [["deny", "mcp gitlab *"], ["allow", "module crm *"]] })
  const read: ToolSource = { kind: "host", group: "workspace", tool: "read_file" }
  expect(await g.gate(read)).toEqual({ run: true, note: "read-only" })
  // Yian's decision for a run with no note is none at all.
  expect(await g.gate({ kind: "memory", input: "profile", tool: "read" })).toBeUndefined()
  expect(await g.gate(MODULE)).toEqual({ run: true, note: "an allow rule" })
  expect(await g.gate({ kind: "mcp", server: "gitlab", tool: "merge" })).toEqual({
    refuse: "Not run: a deny rule: mcp gitlab *.",
  })
  // The terminal still decides its own commands.
  expect(await g.gate({ kind: "host", group: "terminal", tool: "run" })).toBeUndefined()
  expect(g.cards()).toEqual([])
})

test("a held call gets its card only once yian holds it, and Yes releases it, noting who approved", async () => {
  const g = await gated("default")
  expect(isPending(await g.gate(MCP))).toBe(true)
  // An interrupt while the gate decided would write no hold: no card before yian says it holds the call.
  expect(g.cards()).toEqual([])
  g.held()
  const card = await waitFor(() => g.card(), { what: "the card" })
  expect(card).toMatchObject({ source: "approval", status: "open", title: "@minh wants to call a tool" })
  expect(card.approval).toMatchObject({
    kind: "tool",
    tool: "tool_0",
    action: 'tool_0 {"title":"Fix"}',
    reason: "Default mode asks before an MCP tool",
    rules: ["mcp github create_issue"],
  })
  await g.actor.answer(card.id, YES, "option", { by: CEO })
  const release = await g.delivered("release")
  expect(release).toMatchObject({ op: "release", note: `approved by @${CEO}` })
  g.handlers.deliverReply(g.worker, { type: "deliver_reply", id: release.id, seq: 7 })
  await waitFor(() => g.card()?.status === "consumed", { what: "the card consumed" })
  expect(g.deliveries.filter((d) => d.op === "complete")).toEqual([])
})

test("a call yian holds just as its job ends still gets its card", async () => {
  const g = await gated("default")
  expect(isPending(await g.gate(MCP))).toBe(true)
  // The job's result follows the CallHeld at once, before the actor has acted on the hold.
  g.held()
  const call = { node: "chat#0/reply", call_id: g.callId(0), tool: "tool_0" }
  const wait = { ...call, inbox: null, deadline: null, settled: false }
  const result = { type: "result", status: "waiting", run_id: g.runId, output: null, failure: null, waits: [wait] }
  g.handlers.result(g.worker, result)
  expect(await waitFor(() => g.card(), { what: "the card" })).toMatchObject({ status: "open" })
})

test("No completes the held call with the approver's words, and nothing is released", async () => {
  const g = await gated("ask")
  expect(isPending(await g.gate(MODULE))).toBe(true)
  g.held()
  const card = await waitFor(() => g.card(), { what: "the card" })
  await g.actor.answer(card.id, "use the staging repo", "text", { by: CEO })
  expect(await g.delivered("complete")).toMatchObject({
    result: { output: "Not run: the user said no: use the staging repo" },
  })
  expect(g.deliveries.filter((d) => d.op === "release")).toEqual([])
})

test("Esc while the gate decides a call leaves no card: yian writes no hold for an interrupted agent", async () => {
  const g = await gated("default")
  expect(isPending(await g.gate(MCP))).toBe(true)
  const stopped = g.actor.interrupt()
  const interrupt = await waitFor(() => g.deliveries.find((d) => d.op === "interrupt"), { what: "the interrupt" })
  g.handlers.deliverReply(g.worker, { type: "deliver_reply", id: interrupt.id, seq: null, closed: [] })
  await stopped
  await Bun.sleep(100)
  expect(g.cards()).toEqual([])
})

test("starting a Codex or Claude Code session asks only in ask mode, offering its exact words", async () => {
  for (const mode of ["auto", "default", "dontAsk"] as const) {
    const g = await gated(mode)
    expect(await g.gate(START)).toEqual({ run: true, note: "a harness session in its profile" })
  }
  const g = await gated("ask")
  expect(isPending(await g.gate({ kind: "host", group: "claude", tool: "start" }))).toBe(true)
  g.held()
  const card = await waitFor(() => g.card(), { what: "the card" })
  expect(card.approval).toMatchObject({ kind: "tool", reason: "Ask mode", rules: ["host claude start"] })
})

test("in auto, Auto's check judges an MCP or module call from its words and arguments once yian holds it", async () => {
  const check = fakeCheck(["module crm quote"])
  const g = await gated("auto", { runCheck: check.runCheck })
  expect(isPending(await g.gate(MCP, 0))).toBe(true)
  expect(isPending(await g.gate(MODULE, 1, { amount: 5 }))).toBe(true)
  expect(check.judged).toEqual([])
  g.held(0)
  g.held(1)
  // Its run verdict releases the call, noting the check's reason; no card is made.
  expect(await g.delivered("release", 0)).toMatchObject({ note: "Auto's check: it only reads" })
  expect(g.card(0)).toBeUndefined()
  // Its ask verdict holds the call on a card that shows why.
  const card = await waitFor(() => g.card(1), { what: "the module call's card" })
  expect(card.approval).toMatchObject({ reason: "Auto's check: it posts data", rules: ["module crm quote"] })
  expect(check.judged).toEqual([
    { kind: "tool", command: 'mcp github create_issue {"title":"Fix"}', profile: "none", cwd: "", host: "" },
    { kind: "tool", command: 'module crm quote {"amount":5}', profile: "none", cwd: "", host: "" },
  ])
})

test("a session that doesn't ask refuses what would ask, with no card", async () => {
  const g = await gated("dontAsk")
  expect(await g.gate(MCP)).toEqual({
    refuse: "Not run: this session doesn't ask (dontAsk mode): Default mode asks before an MCP tool.",
  })
  expect(g.cards()).toEqual([])
})

test("a rule a Yes adds releases the run's other held calls it now allows, as approved by that rule", async () => {
  const g = await gated("default")
  expect(isPending(await g.gate(MCP, 0))).toBe(true)
  expect(isPending(await g.gate(MCP, 1))).toBe(true)
  expect(isPending(await g.gate(MODULE, 2))).toBe(true)
  for (const n of [0, 1, 2]) g.held(n)
  await waitFor(() => g.cards().length === 3, { what: "three cards" })
  await g.actor.answer(g.card(0)!.id, sessionOption(["mcp github create_issue"]), "option", { by: CEO })
  expect(await g.delivered("release", 0)).toMatchObject({ note: `approved by @${CEO}` })
  expect(await g.delivered("release", 1)).toMatchObject({ note: "an allow rule" })
  expect(g.card(1)).toMatchObject({ status: "answered", answer: YES, answered_by: CEO })
  // The module call's card stays open: the rule doesn't name it.
  expect(g.card(2)!.status).toBe("open")
  expect(g.deliveries.some((d) => d.op === "release" && d.call_id === g.callId(2))).toBe(false)
})

test("removing the ask rule that held a call decides it again, and its row now runs it", async () => {
  const quote: ToolSource = { kind: "host", group: "toolbox", tool: "quote" }
  const g = await gated("auto", { agent: [["ask", "host toolbox *"]] })
  expect(isPending(await g.gate(quote))).toBe(true)
  g.held()
  const card = await waitFor(() => g.card(), { what: "the card" })
  expect(card.approval).toMatchObject({ reason: "an ask rule: host toolbox *", rules: [] })
  const rule = { effect: "ask", kind: "tool", pattern: "host toolbox *", source: "agent" } as const
  expect(await g.actor.removeRule(rule, CEO)).toBe(true)
  const release = await g.delivered("release")
  expect("note" in release).toBe(false)
  expect(g.card()).toMatchObject({ status: "answered", answer: YES, answered_by: CEO })
})

// --- the employee's run, in a real worker ------------------------------------------------------------------------

/** Words only the chat's requests hold. */
const CHAT = "You work in the office alongside"

/** A harness whose toolbox has a `quote` tool counting its calls in `quoted`, with `rules` as the company's tool
 *  rules, and a chat of minh's in `mode`, idle at its first turn. */
async function quoting(fake: Awaited<ReturnType<typeof fakeLlm>>, rules: [string, string][], mode: Mode = "auto") {
  const quoted: unknown[] = []
  const quote: OfficeTool = {
    description: "Quote a price.",
    parameters: { type: "object", properties: { amount: { type: "integer" } }, required: ["amount"] },
    call: (args) => {
      quoted.push(args.amount)
      return `quoted ${String(args.amount)}`
    },
  }
  const h = await makeHarness(fake, { files: { "rules.yaml": toolRules(rules) }, groups: { toolbox: { quote } } })
  const { id } = await h.harness.startSession("minh", h.folder, { openedBy: CEO })
  await waitFor(() => status(h, id) === "idle", { what: "the first turn" })
  h.store.updateSession(id, { mode })
  const open = () => h.store.listQuestions({ sessionId: id, status: "open", source: "approval" })
  const cardOpen = async () => {
    await waitFor(() => open().length === 1 && status(h, id) === "waiting" && !running(h.registry, id), {
      what: "the card",
    })
    return open()[0]!
  }
  return { h, id, quoted, open, cardOpen }
}

/** A rules file's YAML: each `[effect, pattern]` a tool rule. */
function toolRules(rules: [string, string][]): string {
  return stringify({ rules: rules.map(([effect, pattern]) => ({ effect, kind: "tool", pattern })) })
}

/** The employee's reply calling the toolbox's `quote` for `amount`. */
const QUOTE = (amount: number): ScriptedReply => ({
  match: CHAT,
  tool_calls: [{ name: "toolbox_quote", arguments: { amount } }],
})

test("a call an ask rule holds runs once after Yes, where yian held it, and the employee reads its result", async () => {
  const fake = await fakeLlm()
  fake.script(QUOTE(5), { match: "quoted 5", content: "It's quoted." })
  const q = await quoting(fake, [["ask", "host toolbox quote"]])
  await q.h.harness.prompt(q.id, "quote it")
  const card = await q.cardOpen()
  const reason = "an ask rule: host toolbox quote"
  expect(card.approval).toMatchObject({ kind: "tool", tool: "toolbox_quote", reason })
  expect(q.quoted).toEqual([])
  await q.h.harness.answer(card.id, YES, "option", { by: CEO })
  await waitFor(() => texts(q.h, q.id).includes("It's quoted.") && status(q.h, q.id) === "idle", { what: "the reply" })
  expect(q.quoted).toEqual([5])
  expect(q.h.store.getQuestion(card.id)!.status).toBe("consumed")
})

test("a held call No answers runs nothing, and the employee reads the approver's words", async () => {
  const fake = await fakeLlm()
  fake.script(QUOTE(5), { match: "the user said no", content: "I won't." })
  const q = await quoting(fake, [["ask", "host toolbox *"]])
  await q.h.harness.prompt(q.id, "quote it")
  const card = await q.cardOpen()
  await q.h.harness.answer(card.id, "not today", "text", { by: CEO })
  await waitFor(() => texts(q.h, q.id).includes("I won't.") && status(q.h, q.id) === "idle", { what: "the reply" })
  expect(q.quoted).toEqual([])
  expect(JSON.stringify(fake.requests().at(-1)!.messages)).toContain("Not run: the user said no: not today")
})

test("a deny rule refuses the call, which never runs, and the employee reads why", async () => {
  const fake = await fakeLlm()
  fake.script(QUOTE(5), { match: "a deny rule", content: "Refused." })
  const q = await quoting(fake, [["deny", "host toolbox quote"]], "dontAsk")
  await q.h.harness.prompt(q.id, "quote it")
  await waitFor(() => texts(q.h, q.id).includes("Refused.") && status(q.h, q.id) === "idle", { what: "the reply" })
  expect(q.quoted).toEqual([])
  expect(q.open()).toEqual([])
})

test("after a restart, an open hold is decided again by the rules read then", async () => {
  const fake = await fakeLlm()
  fake.script(QUOTE(7), { match: "quoted 7", content: "Quoted after all." })
  const q = await quoting(fake, [["ask", "host toolbox quote"]])
  await q.h.harness.prompt(q.id, "quote it")
  const card = await q.cardOpen()
  // The office stops with the card open; the ask rule goes while it is down.
  await q.h.reopen()
  const company = q.h.office.paths.company
  fs.writeFileSync(path.join(company, "rules.yaml"), toolRules([]))
  git(company, "commit", "-qam", "no ask rule for quotes")
  await q.h.harness.restore()
  await waitFor(() => texts(q.h, q.id).includes("Quoted after all.") && status(q.h, q.id) === "idle", {
    what: "the released call's reply",
  })
  expect(q.quoted).toEqual([7])
  expect(q.h.store.getQuestion(card.id)).toMatchObject({ answer: YES })
})

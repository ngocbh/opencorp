/** A company tool module granted to an employee's agent: each model call of its tools goes through the session's gate
 *  as a module's tool (ask holds it on a card, dontAsk refuses it, auto hands it to Auto's check, a deny rule refuses
 *  it in every mode), and the module runs with no office context. */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { stringify } from "yaml"
import type { CheckInput } from "../../../src/runtime/permissions/policy.ts"
import type { CheckRunner } from "../../../src/runtime/permissions/classifier.ts"
import { YES } from "../../../src/runtime/questions/approval.ts"
import { CEO } from "../../server/helpers.ts"
import { waitFor } from "../../helpers.ts"
import {
  CHAT_FLOW, card, chatOffice, fakeLlm, makeActor, newSession, noWorkersLeft, status, texts,
} from "./helpers.ts"

setDefaultTimeout(90_000)
afterAll(noWorkersLeft)

/** Words only the chat's requests hold. */
const CHAT = "You work in the office alongside"

/** The company's tool module: `quote` says what it quoted and whether it was handed an office context. */
const CRM = `export const quote = {
  name: "quote",
  description: "Quote a price.",
  parameters: { type: "object", properties: { amount: { type: "integer" } }, required: ["amount"] },
  execute: async (args, ctx) => \`quoted \${args.amount}; context \${ctx?.context === undefined ? "none" : "given"}\`,
}
`

/** A flow def that prices an order by calling the module's `quote` itself. */
const PRICED = "  priced:\n    description: Price an order.\n    input:\n      amount: !int\n    nodes:\n      quoted:\n"
  + "        kind: call\n        call: {crm: quote}\n        input:\n          amount: ${input.amount}\n"
  + "    output: ${quoted.output}\n"

/** The template's chat flow, its agent granted the module as `crm`, and `priced`, a flow that calls it. */
const MODULE_CHAT = CHAT_FLOW
  .replace("uses:\n  compact_history: compact_history", "uses:\n  crm: ./crm.ts\n  compact_history: compact_history")
  .replace("\ndefs:\n", `\ndefs:\n${PRICED}`)
  .replace("tools: [toolbox, workspace, terminal, codex, claude, company, ask_user]",
    "tools: [toolbox, workspace, terminal, codex, claude, company, ask_user, crm, priced]")

/** The employee's reply that calls the module's `quote` for 5. */
const QUOTE = { match: CHAT, tool_calls: [{ name: "crm_quote", arguments: { amount: 5 } }] }

/** A chat office whose company grants the module, with `rules` (`[effect, pattern]`, tool rules) in its rules.yaml,
 *  and a session of minh's in `mode` with `runCheck` as Auto's check, idle at its first turn. */
async function moduled(fake: Awaited<ReturnType<typeof fakeLlm>>, mode: string, o: { rules?: [string, string][]; runCheck?: CheckRunner } = {}) {
  expect(MODULE_CHAT).toContain("crm: ./crm.ts")
  expect(MODULE_CHAT).toContain("ask_user, crm, priced]")
  expect(MODULE_CHAT).toContain("call: {crm: quote}")
  const rules = stringify({ rules: (o.rules ?? []).map(([effect, pattern]) => ({ effect, kind: "tool", pattern })) })
  const office = await chatOffice(fake, {
    files: { "shared/flows/chat.yaml": MODULE_CHAT, "shared/flows/crm.ts": CRM, "rules.yaml": rules },
  })
  const sid = await newSession(office, { openedBy: CEO })
  const actor = makeActor(office, sid, o.runCheck === undefined ? {} : { runCheck: o.runCheck })
  await actor.start()
  await waitFor(() => status(office, sid) === "idle", { what: "the first turn" })
  office.office.store.updateSession(sid, { mode: mode as "auto" })
  const replied = (text: string) =>
    waitFor(() => texts(office, sid).includes(text) && status(office, sid) === "idle", { what: `the reply ${text}` })
  return { office, sid, actor, replied }
}

test("in ask a model call of a module tool holds on a card; Yes runs it once, with no office context", async () => {
  const fake = await fakeLlm()
  fake.script(QUOTE, { match: "quoted 5; context none", content: "Quoted." })
  const m = await moduled(fake, "ask")
  await m.actor.prompt("quote it")
  const q = await card(m.office, m.sid, "approval")
  expect(q.approval).toMatchObject({ kind: "tool", tool: "crm_quote", reason: "Ask mode", rules: ["module crm quote"] })
  expect(q.question).toBe('crm_quote {"amount":5}')
  await m.actor.answer(q.id, YES, "option", { by: CEO })
  await m.replied("Quoted.")
})

test("in dontAsk a model call of a module tool is refused, and the module never runs", async () => {
  const fake = await fakeLlm()
  const refused = "Not run: this session doesn't ask (dontAsk mode): no allow rule covers a tool module's tool."
  fake.script(QUOTE, { match: refused, content: "Refused." })
  const m = await moduled(fake, "dontAsk")
  await m.actor.prompt("quote it")
  await m.replied("Refused.")
  expect(JSON.stringify(fake.requests())).not.toContain("quoted 5")
  expect(m.office.office.store.listQuestions({ sessionId: m.sid })).toEqual([])
})

test("in auto Auto's check judges a model call of a module tool from its words and arguments, and its run runs it", async () => {
  const fake = await fakeLlm()
  fake.script(QUOTE, { match: "quoted 5; context none", content: "Quoted." })
  const judged: CheckInput[] = []
  const runCheck: CheckRunner = async (input) => {
    judged.push(input)
    return { output: { verdict: "run", reason: "it only prices an order" } }
  }
  const m = await moduled(fake, "auto", { runCheck })
  await m.actor.prompt("quote it")
  await m.replied("Quoted.")
  expect(judged).toEqual([{ kind: "tool", command: 'module crm quote {"amount":5}', profile: "none", cwd: "", host: "" }])
  expect(m.office.office.store.listQuestions({ sessionId: m.sid })).toEqual([])
})

test("a deny rule on a module tool refuses its model calls in every mode, before Auto's check", async () => {
  const denied = "Not run: a deny rule: module crm quote."
  for (const mode of ["auto", "default", "ask", "dontAsk"]) {
    const fake = await fakeLlm()
    fake.script(QUOTE, { match: denied, content: `Denied in ${mode}.` })
    const judged: CheckInput[] = []
    const runCheck: CheckRunner = async (input) => {
      judged.push(input)
      return { output: { verdict: "run", reason: "fine" } }
    }
    const m = await moduled(fake, mode, { rules: [["deny", "module crm quote"]], runCheck })
    await m.actor.prompt("quote it")
    await m.replied(`Denied in ${mode}.`)
    expect([mode, judged, m.office.office.store.listQuestions({ sessionId: m.sid })]).toEqual([mode, [], []])
    expect(JSON.stringify(fake.requests())).not.toContain("quoted 5")
  }
})

/** The employee's reply that calls the granted flow `priced` for 5. */
const PRICE = { match: CHAT, tool_calls: [{ name: "priced", arguments: { amount: 5 } }] }

test("an agent's call of a granted flow that calls a module tool runs with no card in ask: granting it approved the tool", async () => {
  const fake = await fakeLlm()
  fake.script(PRICE, { match: "quoted 5; context none", content: "Priced." })
  const m = await moduled(fake, "ask")
  await m.actor.prompt("price it")
  await m.replied("Priced.")
  expect(m.office.office.store.listQuestions({ sessionId: m.sid })).toEqual([])
})

test("a deny rule on a module tool a granted flow calls refuses the agent's call of the flow", async () => {
  const fake = await fakeLlm()
  const refused = "Not run: a deny rule: module crm quote, on module crm quote, which this flow calls."
  fake.script(PRICE, { match: refused, content: "Refused." })
  const m = await moduled(fake, "auto", { rules: [["deny", "module crm quote"]] })
  await m.actor.prompt("price it")
  await m.replied("Refused.")
  expect(JSON.stringify(fake.requests())).not.toContain("quoted 5")
})

test("in dontAsk a granted flow that calls a module tool runs only when an allow rule covers the tool", async () => {
  const refused = "Not run: this session doesn't ask (dontAsk mode): no allow rule covers module crm quote, which this flow calls."
  const fake = await fakeLlm()
  fake.script(PRICE, { match: refused, content: "Refused." })
  const m = await moduled(fake, "dontAsk")
  await m.actor.prompt("price it")
  await m.replied("Refused.")
  const allowed = await fakeLlm()
  allowed.script(PRICE, { match: "quoted 5; context none", content: "Priced." })
  const n = await moduled(allowed, "dontAsk", { rules: [["allow", "module crm quote"]] })
  await n.actor.prompt("price it")
  await n.replied("Priced.")
})

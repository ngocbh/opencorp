/** The company template's chat flows (Python's `tests/chat/test_template.py`). */
import { expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runFlow, tool } from "@ngocbh/yian"
import { readFlow } from "../../src/company/flow_yaml.ts"
import { loadConfined } from "../../src/company/flows.ts"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
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

test("the template ends no session by time and its chats have no loop cap", () => {
  expect(fs.readFileSync(path.join(ROOT, "company.yaml"), "utf8")).not.toContain("idle_end")
  for (const file of [CHAT, SIDE, MANAGER]) expect(fs.readFileSync(file, "utf8")).not.toContain("max:")
})

/** A tool that does nothing, so every toolset a template names has one. */
function stub(name: string) {
  return tool({ name, description: "Do nothing.", parameters: { type: "object", properties: {} }, execute: () => "ok" })
}

const PERSON = { name: "Minh", handle: "minh", title: "Engineer", company: "Acme", reports_to: "" }
const EARLIER = [
  { role: "user", text: "earlier" },
  { role: "assistant", text: "ok" },
]

test.each([
  ["chat", CHAT],
  ["side_chat", SIDE],
  ["profile_manager", MANAGER],
])("a template chat carries its history in the prompt list and ends on exit [%s]", async (name, file) => {
  const flow = await loadConfined(ROOT, file)
  const fake = await fakeLlm()
  fake.script({ content: "hello" })
  fake.script({ content: "fine" })
  const answers = ["hi", "again", "/exit"]
  const inputs = name === "profile_manager" ? { history: EARLIER } : { person: PERSON, talking_to: "", history: EARLIER }
  const result = await runFlow(flow, inputs, {
    llmConfig: LLM_CONFIG,
    env: (n) => fake.env()[n],
    skills: new Map(),
    tools: {
      toolbox: [stub("toolbox_stub")],
      workspace: [stub("workspace_stub")],
      company: [stub("company_stub")],
      work_items: [stub("work_items_stub")],
      profile: [stub("profile_stub")],
      ask_user: async () => answers.shift() ?? "/exit",
    },
  })
  expect([result.status, result.output]).toEqual(["succeeded", ""])
  const requests = fake.requests() as { messages: { role: string; content: unknown }[] }[]
  expect(requests).toHaveLength(2)
  expect(requests[1]!.messages.slice(1).map(({ role, content }) => ({ role, content }))).toEqual([
    { role: "user", content: "earlier" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "again" },
  ])
  const ends = new Map<string, any>()
  for (const event of result.events) {
    if (event.type === "NodeSucceeded" && /^chat#\d+\/__end__$/.test(event.nodeId)) ends.set(event.nodeId, event.output)
  }
  const last = ends.get("chat#2/__end__")
  expect(last.exited).toBe(true)
  expect(last.history).toEqual([
    ...EARLIER,
    { role: "user", text: "hi" },
    { role: "assistant", text: "hello" },
    { role: "user", text: "again" },
    { role: "assistant", text: "fine" },
  ])
  expect(last.history).toEqual(ends.get("chat#1/__end__").history)
})

/** The company template's chat flows (Python's `tests/chat/test_template.py`). */
import { expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readFlow } from "../../src/company/flow_yaml.ts"
import { loadConfined } from "../../src/company/flows.ts"

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

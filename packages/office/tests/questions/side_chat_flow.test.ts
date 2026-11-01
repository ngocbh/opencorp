/** The company template's side-chat flow (Python's `tests/questions/test_side_chat_flow.py`). */
import { expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readFlow } from "../../src/company/flow_yaml.ts"
import { loadConfined } from "../../src/company/flows.ts"

setDefaultTimeout(30_000)

const ROOT = fileURLToPath(new URL("../../src/company_template/template/", import.meta.url))
const SIDE_CHAT = path.join(ROOT, "shared", "flows", "side_chat.yaml")

function read(): Record<string, any> {
  return readFlow(fs.readFileSync(SIDE_CHAT, "utf8")) as Record<string, any>
}

test("side chat template loads and has the chat shape", async () => {
  expect((await loadConfined(ROOT, SIDE_CHAT)).name).toBe("side_chat")
  const flow = read()
  const turn = flow.defs.turn.nodes
  expect(flow.nodes.chat.kind).toBe("loop")
  expect([turn.heard.kind, turn.heard.tool_id, turn.heard.input.from]).toEqual(["tool", "take", "${input.messages}"])
  expect(turn.route.cases).toEqual([{ when: "${heard.output.events != [] and not heard.output.closed}", then: "context" }])
  const reply = turn.reply
  expect([reply.steer_inbox, reply.output, reply.long_term_memory]).toEqual([
    "${input.messages}",
    "Optional(str)",
    "profile",
  ])
})

test("side chat tools are read only lookups", () => {
  const reply = read().defs.turn.nodes.reply
  expect(reply.tools).toEqual(["workspace", "work_items"])
  expect(reply).not.toHaveProperty("skills")
})

test("side chat takes the person into the replys system prompt", () => {
  const flow = read()
  expect(flow.input).toHaveProperty("person")
  const reply = flow.defs.turn.nodes.reply
  expect(reply.system_prompt.startsWith("You are ${person.name} (@${person.handle})")).toBe(true)
})

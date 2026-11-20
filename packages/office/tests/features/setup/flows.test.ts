/** `opencorp init`'s setup flow on TS yian: it loads as the office loads it, in the chat flow's shape, and its agent
 *  sees only what it is given. */
import { expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadFlow } from "@ngocbh/yian"
import { readFlow } from "../../../src/company/flow_yaml.ts"
import { loadConfined } from "../../../src/company/flows.ts"
import { embedded } from "../../../src/platform.ts"
import initYaml from "../../../src/features/setup/flows/init.yaml" with { type: "file" }

setDefaultTimeout(30_000)

const DIR = fileURLToPath(new URL("../../../src/features/setup/flows/", import.meta.url))
const FLOWS = fs.readdirSync(DIR).filter((name) => name.endsWith(".yaml"))

/** A setup flow's YAML, as the office's strict reader parses it. */
function read(name: string): Record<string, any> {
  return readFlow(fs.readFileSync(path.join(DIR, name), "utf8")) as Record<string, any>
}

test.each(FLOWS)("every setup flow loads on ts yian [%s]", async (name) => {
  const base = path.basename(name, ".yaml")
  expect((await loadConfined(DIR, path.join(DIR, name))).name).toBe(base)
  expect((await loadFlow(fs.readFileSync(path.join(DIR, name), "utf8"), { sourceLabel: name })).name).toBe(base)
})

test("init loads from its embedded bytes", async () => {
  const flow = await loadFlow(embedded(initYaml).toString("utf8"), { sourceLabel: "features/setup/flows/init.yaml" })
  expect(flow.name).toBe("init")
  expect(flow.input.map((p) => p.name)).toEqual(["messages", "known"])
})

test("init loads with the chat flow's shape, grants ask_user and propose_company, steers from messages, and its prompt never asks for a password, a key, a token or a remote", () => {
  const flow = read("init.yaml")
  // No remote: a remote URL can hold credentials, so it never reaches the model.
  expect(Object.keys(flow.input)).toEqual(["messages", "known"])
  expect(flow.input.messages).toBe("!Inbox(Message)")
  // One LOOP of turns, as the chat flow's, ending once the owner accepted the company or the inbox closes.
  expect(Object.keys(flow.nodes)).toEqual(["chat"])
  expect(flow.nodes.chat).toMatchObject({ kind: "loop", call: "turn", while: "not closed and not accepted" })
  const turn = flow.defs.turn
  expect(Object.keys(turn.nodes)).toEqual(["heard", "route", "reply"])
  expect(turn.nodes.heard).toEqual({ kind: "call", call: "take", input: { from: "${input.messages}", take: "all" } })
  const reply = turn.nodes.reply
  expect(reply.kind).toBe("agent")
  expect(reply.steer_inbox).toBe("${input.messages}")
  expect(reply.tools).toEqual(["ask_user", "propose_company"])
  expect(reply.prompt).toEqual(["${history}", "${said}"])
  expect(Object.keys(reply.input).sort()).toEqual(["history", "known", "said"])
  // `accepted` is propose_company's own result, never the model's words.
  expect(turn.output.accepted).toContain('p.name == "propose_company"')
  expect(turn.output.accepted).toContain('p.type == "tool_result"')
  expect(turn.output.accepted).toContain('startswith(p.content, "Accepted:")')
  // Every placeholder in the system prompt is one of its inputs: nothing else reaches the model there.
  const placeholders = [...(reply.system_prompt as string).matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1])
  expect(placeholders).toEqual(["known"])
  const prompt = (reply.system_prompt as string).replace(/\s+/g, " ")
  expect(prompt).toContain("Never ask for a password, an API key, a token or a git remote URL")
  expect(prompt).toContain("Ask one short question at a time in your reply")
  expect(prompt).toContain("call propose_company")
  expect(prompt).toContain('Once propose_company says "Accepted", reply with one line for the owner')
  expect(prompt).toContain("Offer one made from the person's name, such as")
  for (const word of ["password", "remote", "token"]) expect(JSON.stringify(reply.input)).not.toContain(word)
})

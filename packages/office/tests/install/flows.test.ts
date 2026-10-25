/** `opencorp init`'s setup flows on TS yian: they load, use node kinds both yian versions take, and run. */
import { expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadFlow, runFlow, tool } from "@ngocbh/yian"
import { readFlow } from "../../src/company/flow_yaml.ts"
import { loadConfined } from "../../src/company/flows.ts"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { checkCompanyTool } from "../../src/tools/company/draft.ts"
import { fakeLlm } from "../chat/helpers.ts"

setDefaultTimeout(30_000)

const DIR = fileURLToPath(new URL("../../src/install/flows/", import.meta.url))
const FLOWS = ["check_model.yaml", "init.yaml"]

/** A setup flow as the office loads its embedded text. */
function load(name: string) {
  return loadFlow(fs.readFileSync(path.join(DIR, name), "utf8"), { sourceLabel: name })
}

/** A setup flow's YAML, as the office's strict reader parses it. */
function read(name: string): Record<string, any> {
  return readFlow(fs.readFileSync(path.join(DIR, name), "utf8")) as Record<string, any>
}

/** Every node of a flow: the top level's and each LOOP's inline ones; a single-node flow is its own node. */
function nodes(flow: Record<string, any>): Record<string, any>[] {
  const top: Record<string, any>[] = flow.nodes ? Object.values(flow.nodes) : [flow]
  return top.flatMap((node) => [node, ...(node.kind === "loop" && node.nodes ? Object.values<any>(node.nodes) : [])])
}

test.each(FLOWS)("both setup flows load on ts yian [%s]", async (name) => {
  const base = path.basename(name, ".yaml")
  expect((await loadConfined(DIR, path.join(DIR, name))).name).toBe(base)
  expect((await load(name)).name).toBe(base)
})

test("the setup flows use only node kinds both yian versions take", () => {
  for (const name of FLOWS) {
    for (const node of nodes(read(name))) {
      expect(["agent", "code", "loop", "tool"]).toContain(node.kind)
      expect(node).not.toHaveProperty("steerable")
      // Their meaning as a TOOL node's tool moves in yian #1078.
      if (node.kind === "tool") expect(["ask", "ask_user", "sleep", "take"]).not.toContain(node.tool_id)
    }
  }
})

test("the model never sees the password or the remote", () => {
  const flow = read("init.yaml")
  const interview = flow.nodes.rounds.nodes.interview
  expect(interview.kind).toBe("agent")
  expect(Object.keys(interview.input)).toEqual(["known", "draft", "changes"])
  expect(interview.tools).toEqual(["ask_user", "check_company"])
  expect([flow.nodes.password.kind, flow.nodes.password.tool_id]).toEqual(["tool", "ask_password"])
  expect([flow.nodes.remote.kind, flow.nodes.remote.tool_id]).toEqual(["tool", "ask_remote"])
})

test("check model asks for one word and returns it", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "OK" })
  const result = await runFlow(await load("check_model.yaml"), {}, { llmConfig: LLM_CONFIG, env: (n) => fake.env()[n] })
  expect([result.status, result.output]).toEqual(["succeeded", "OK"])
})

const OWNER = { name: "Hong Ngoc Bui", handle: "ngocbh", title: "CEO" }
const ANSWERS = {
  company: "Acme",
  owner: OWNER,
  teammates: [{ name: "Minh", handle: "minh", title: "Engineer", about: "Writes the backend." }],
}

test("init runs its interview then asks for the password and the remote through the office tools", async () => {
  const calls: string[] = []
  const confirm_company = tool({
    name: "confirm_company",
    description: "Confirm.",
    parameters: { type: "object", properties: { answers: { type: "object" } } },
    execute: (a: any) => {
      calls.push("confirm_company")
      return { draft: JSON.stringify(a.answers), changes: "", accepted: true }
    },
  })
  const ask_password = tool({
    name: "ask_password",
    description: "Ask.",
    parameters: { type: "object", properties: {} },
    execute: () => {
      calls.push("ask_password")
      return "scrypt$x"
    },
  })
  const ask_remote = tool({
    name: "ask_remote",
    description: "Ask.",
    parameters: { type: "object", properties: { given: { type: "string" } } },
    execute: (a: any) => {
      calls.push("ask_remote")
      return a.given
    },
  })
  const fake = await fakeLlm()
  fake.script({ tool_calls: [{ name: "check_company", arguments: { company: "Acme", owner: OWNER, teammates: [] } }] })
  fake.script({ content: "done" })
  // yian takes an AGENT's structured output by a forced Record call.
  fake.script({ tool_calls: [{ name: "Record", arguments: ANSWERS }] })
  const result = await runFlow(
    await load("init.yaml"),
    { known: "{}", remote: "git@example.com:acme.git" },
    {
      llmConfig: LLM_CONFIG,
      env: (n) => fake.env()[n],
      numWorkers: 0,
      tools: {
        check_company: checkCompanyTool,
        confirm_company,
        ask_password,
        ask_remote,
        ask_user: async () => "x",
      },
    },
  )
  expect(result.status).toBe("succeeded")
  expect(result.output).toEqual({ ...ANSWERS, password_hash: "scrypt$x", remote: "git@example.com:acme.git" })
  expect(calls).toEqual(["confirm_company", "ask_password", "ask_remote"])
  const requests = fake.requests() as {
    tools?: { function: { name: string } }[]
    messages: { role: string; content: unknown }[]
  }[]
  expect(requests[0]!.tools!.map((t) => t.function.name)).toEqual(["ask_user", "check_company"])
  expect(requests[1]!.messages).toContainEqual(expect.objectContaining({ role: "tool", content: "No problems." }))
})

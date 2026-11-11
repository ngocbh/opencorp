/** The reach flows on TS yian: they load as the office loads them, `reach_hq` holds no agent, and `learn_hq`'s agent
 *  sees only what it is given. */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, setDefaultTimeout, test } from "bun:test"
import { loadFlow } from "@ngocbh/yian"
import { readFlow } from "../../src/company/flow_yaml.ts"
import { loadConfined } from "../../src/company/flows.ts"
import { embedded } from "../../src/platform.ts"
import { learnYaml } from "../../src/reach/learn.ts"
import { reachYaml } from "../../src/reach/replay.ts"

setDefaultTimeout(30_000)

const DIR = fileURLToPath(new URL("../../src/reach/flows/", import.meta.url))

test.each(["reach_hq.yaml", "learn_hq.yaml"])("every reach flow loads on ts yian [%s]", async (name) => {
  const base = path.basename(name, ".yaml")
  expect((await loadConfined(DIR, path.join(DIR, name))).name).toBe(base)
  const text = fs.readFileSync(path.join(DIR, name), "utf8")
  expect((await loadFlow(text, { sourceLabel: name })).name).toBe(base)
})

test("reach_hq has no agent node, so a replay resolves no model", () => {
  const flow = readFlow(fs.readFileSync(path.join(DIR, "reach_hq.yaml"), "utf8")) as Record<string, any>
  const nodes = Object.values<Record<string, unknown>>(flow.nodes)
  expect(nodes.length).toBeGreaterThan(0)
  for (const node of nodes) expect([node.kind, node.tool_id]).toEqual(["tool", "replay_access"])
})

test("learn_hq's agent sees only the old notes, script and failure, with shell, ask_user and save_access, and 30 turns", () => {
  const flow = readFlow(fs.readFileSync(path.join(DIR, "learn_hq.yaml"), "utf8")) as Record<string, any>
  expect(Object.keys(flow.input)).toEqual(["notes", "script", "failure"])
  expect(Object.keys(flow.nodes)).toEqual(["learn"])
  const learn = flow.nodes.learn
  expect(learn.kind).toBe("agent")
  expect(learn.tools).toEqual(["shell", "ask_user", "save_access"])
  expect(learn.env).toEqual({ max_tool_iterations: 30 })
  expect(learn.input).toEqual({ notes: "${input.notes}", script: "${input.script}", failure: "${input.failure}" })
  expect(learn.output).toBe("str")
  // Every placeholder in the prompt is one of its inputs: nothing else reaches the model.
  const placeholders = [...(learn.prompt as string).matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1])
  expect(placeholders).toEqual(["notes", "script", "failure"])
})

test.each([
  ["reach_hq", reachYaml],
  ["learn_hq", learnYaml],
])("%s loads from its embedded bytes", async (name, file) => {
  const flow = await loadFlow(embedded(file).toString("utf8"), { sourceLabel: `reach/flows/${name}.yaml` })
  expect(flow.name).toBe(name)
})

/** The reach flows on TS yian: they load as the office loads them, and `reach_hq` holds no agent. */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, setDefaultTimeout, test } from "bun:test"
import { loadFlow } from "@ngocbh/yian"
import { readFlow } from "../../src/company/flow_yaml.ts"
import { loadConfined } from "../../src/company/flows.ts"
import { embedded } from "../../src/platform.ts"
import { reachYaml } from "../../src/reach/replay.ts"

setDefaultTimeout(30_000)

const DIR = fileURLToPath(new URL("../../src/reach/flows/", import.meta.url))

test.each(["reach_hq.yaml"])("every reach flow loads on ts yian [%s]", async (name) => {
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

test("reach_hq loads from its embedded bytes", async () => {
  const flow = await loadFlow(embedded(reachYaml).toString("utf8"), { sourceLabel: "reach/flows/reach_hq.yaml" })
  expect(flow.name).toBe("reach_hq")
})

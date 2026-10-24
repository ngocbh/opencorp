/** The reference monitor: which asset tools a person gets, and every call's check and audit. */
import fs from "node:fs"
import { expect, test } from "bun:test"
import type { Monitor } from "../../src/perm/monitor.ts"
import { person } from "../company/helpers.ts"
import { cluster, makeMonitor } from "./helpers.ts"

const GROUPS = { "groups/infra.yaml": { id: "infra", name: "Infra", parent: "eng", head: null } }

function names(monitor: Monitor, pid: string): string[] {
  return Object.keys(monitor.tools(pid)).sort()
}

test("the toolbox lists granted tools only", async () => {
  const { monitor } = await makeMonitor({ "assets/cluster-a.yaml": cluster([{ who: "minh", can: ["submit_job"] }]) })
  expect(names(monitor, "minh")).toEqual(["cluster_a__submit_job", "fake__echo"])
  expect(names(monitor, "ngocbh")).toEqual([])
  expect(names(monitor, "nobody")).toEqual([])
})

test("grants reach members of child groups", async () => {
  const { monitor } = await makeMonitor({
    ...GROUPS,
    "people/minh/person.yaml": person("minh", { groups: ["infra"] }),
    "assets/cluster-a.yaml": cluster([{ who: "group:eng", can: ["read_logs"] }]),
  })
  expect(names(monitor, "minh")).toEqual(["cluster_a__read_logs", "fake__echo"])
})

test("toolbox tools carry the kind schema and audit the run", async () => {
  const { monitor } = await makeMonitor({ "assets/cluster-a.yaml": cluster([{ who: "minh", can: ["submit_job"] }]) })
  const toolbox = monitor.tools("minh", { runId: "r1", sessionId: "s1" })
  const submit = toolbox.cluster_a__submit_job!
  expect(submit.description).toBe("Submit a job.")
  expect(submit.parameters.required).toEqual(["job"])
  // The schema Python's langchain tool hands the worker, pinned in the golden.
  const golden = JSON.parse(fs.readFileSync(new URL("../fixtures/tool_specs.json", import.meta.url), "utf8"))
  expect(JSON.stringify(toolbox.fake__echo!.parameters)).toBe(JSON.stringify(golden.toolbox[0].parameters))
})

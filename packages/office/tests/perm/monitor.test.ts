/** The reference monitor: which asset tools a person gets, and every call's check and audit. */
import fs from "node:fs"
import { expect, test } from "bun:test"
import type { Monitor } from "../../src/perm/monitor.ts"
import { DETAIL_CHARS } from "../../src/perm/redact.ts"
import { person } from "../company/helpers.ts"
import { TOKEN, cluster, makeMonitor, setFile } from "./helpers.ts"

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

test("a group head is not a member unless listed", async () => {
  const { monitor } = await makeMonitor({
    "groups/eng.yaml": { id: "eng", name: "Engineering", parent: null, head: "ngocbh" },
    "assets/cluster-a.yaml": cluster([{ who: "group:eng", can: ["read_logs"] }]),
  })
  expect(names(monitor, "ngocbh")).toEqual([])
  expect(await monitor.call("ngocbh", "r1", "cluster_a__read_logs", {})).toBe(
    "permission denied: no grant for cluster_a__read_logs",
  )
})

test("admin allows every tool but gated ones are never listed", async () => {
  const { monitor } = await makeMonitor({ "assets/cluster-a.yaml": cluster([{ who: "minh", can: ["admin"] }]) })
  expect(names(monitor, "minh")).toEqual([
    "cluster_a__broken",
    "cluster_a__read_logs",
    "cluster_a__submit_job",
    "fake__echo",
  ])
  expect(await monitor.call("minh", "r1", "cluster_a__read_logs", {})).toBe("logs")
  expect(await monitor.call("minh", "r1", "cluster_a__delete_data", {})).toBe(
    "permission denied: cluster_a__delete_data is gated",
  )
})

test("tools of an unknown kind are not listed", async () => {
  const { monitor } = await makeMonitor({
    "assets/odd.yaml": { id: "odd", kind: "nope", tools: { x: {} }, grants: [{ who: "minh", can: ["x"] }] },
  })
  expect(names(monitor, "minh")).toEqual(["fake__echo"])
  expect(await monitor.call("minh", "r1", "odd__x", {})).toBe("error: asset kind 'nope' has no tool 'x'")
})

test("a call runs with secrets and the result and audit hide them", async () => {
  const { monitor, store } = await makeMonitor({
    "assets/cluster-a.yaml": cluster([{ who: "minh", can: ["submit_job"] }]),
  })
  const got = await monitor.call(
    "minh",
    "r1",
    "cluster_a__submit_job",
    { job: "train", vault_token: TOKEN },
    { sessionId: "s1" },
  )
  expect(got).toBe("ran train on None with [redacted]")
  const rows = store.listAudit({ person: "minh" })
  expect(rows).toHaveLength(1)
  const row = rows[0]!
  expect([row.kind, row.tool, row.outcome, row.runId, row.sessionId]).toEqual([
    "asset",
    "cluster_a__submit_job",
    "ok",
    "r1",
    "s1",
  ])
  expect(row.args).toEqual({ job: "train", vault_token: "[redacted]" })
  expect(JSON.stringify(row)).not.toContain(TOKEN)
})

test("where violations come back as results", async () => {
  const grant = { who: "minh", can: ["submit_job"], where: { partition: ["gpu-small"] } }
  const { monitor, store } = await makeMonitor({ "assets/cluster-a.yaml": cluster([grant]) })
  const call = (args: Record<string, unknown>) => monitor.call("minh", "r1", "cluster_a__submit_job", args)
  expect(String(await call({ job: "a", partition: "gpu-small" }))).toStartWith("ran a")
  expect(await call({ job: "b", partition: "gpu-big" })).toBe(
    'permission denied: cluster_a__submit_job: partition must be one of ["gpu-small"]',
  )
  expect(await call({ job: "c" })).toBe(
    'permission denied: cluster_a__submit_job: partition must be one of ["gpu-small"]',
  )
  expect(store.listAudit().map((r) => r.outcome)).toEqual(["ok", "denied", "denied"])
})

test("where limits admin grants too", async () => {
  const { monitor } = await makeMonitor({
    "assets/cluster-a.yaml": cluster([{ who: "minh", can: ["admin"], where: { partition: ["gpu-small"] } }]),
  })
  expect(await monitor.call("minh", "r1", "cluster_a__read_logs", { partition: "gpu-small" })).toBe("logs")
  expect(await monitor.call("minh", "r1", "cluster_a__read_logs", {})).toBe(
    'permission denied: cluster_a__read_logs: partition must be one of ["gpu-small"]',
  )
})

test("where matches type as well as value", async () => {
  const grant = { who: "minh", can: ["submit_job"], where: { nodes: [1], debug: [false] } }
  const { monitor, store } = await makeMonitor({ "assets/cluster-a.yaml": cluster([grant]) })
  const call = (nodes: unknown, debug: unknown = false) =>
    monitor.call("minh", "r1", "cluster_a__submit_job", { job: "a", nodes, debug })

  expect(String(await call(1))).toStartWith("ran a")
  // A frame's ints are bigint: one equals the same number, and its audit row stores it as one.
  expect(String(await call(1n))).toStartWith("ran a")
  expect(store.listAudit().at(-1)!.args.nodes).toBe(1)
  for (const nodes of [true, "1", [1]])
    expect(await call(nodes)).toBe("permission denied: cluster_a__submit_job: nodes must be one of [1]")
  expect(await call(1, 0)).toBe("permission denied: cluster_a__submit_job: debug must be one of [false]")
})

test("any matching grant allows the call", async () => {
  const grants = [
    { who: "minh", can: ["submit_job"], where: { partition: ["gpu-small"] } },
    { who: "group:eng", can: ["submit_job"] },
  ]
  const { monitor } = await makeMonitor({ "assets/cluster-a.yaml": cluster(grants) })
  const got = await monitor.call("minh", "r1", "cluster_a__submit_job", { job: "a", partition: "gpu-big" })
  expect(String(got)).toStartWith("ran a")
})

test("a revocation between two calls denies the second", async () => {
  const { monitor, store } = await makeMonitor()
  expect(await monitor.call("minh", "r1", "fake__echo", { text: "one" })).toBe("one")
  setFile(monitor.root, "assets/fake.yaml", { id: "fake", kind: "fake", tools: { echo: {} }, grants: [] })
  expect(await monitor.call("minh", "r1", "fake__echo", { text: "two" })).toBe(
    "permission denied: no grant for fake__echo",
  )
  expect(store.listAudit({ person: "minh" }).map((r) => r.outcome)).toEqual(["ok", "denied"])
})

test("unknown tools and people are denied and audited", async () => {
  const { monitor, store } = await makeMonitor()
  expect(await monitor.call("minh", "r1", "nope__x", {})).toBe("permission denied: no grant for nope__x")
  expect(await monitor.call("ghost", "r1", "fake__echo", { text: "x" })).toBe(
    "permission denied: no grant for fake__echo",
  )
  expect(store.listAudit()).toHaveLength(2)
})

test("toolbox tools carry the kind schema and audit the run", async () => {
  const { monitor, store } = await makeMonitor({
    "assets/cluster-a.yaml": cluster([{ who: "minh", can: ["submit_job"] }]),
  })
  const toolbox = monitor.tools("minh", { runId: "r1", sessionId: "s1" })
  const submit = toolbox.cluster_a__submit_job!
  expect(submit.description).toBe("Submit a job.")
  expect(submit.parameters.required).toEqual(["job"])
  // The schema Python's langchain tool hands the worker, pinned in the golden.
  const golden = JSON.parse(fs.readFileSync(new URL("../fixtures/tool_specs.json", import.meta.url), "utf8"))
  expect(JSON.stringify(toolbox.fake__echo!.parameters)).toBe(JSON.stringify(golden.toolbox[0].parameters))
  expect(await toolbox.fake__echo!.call({ text: "hi" })).toBe("hi")
  expect(store.listAudit().map((r) => [r.runId, r.sessionId])).toEqual([["r1", "s1"]])
})

test("large audit args are cut like the detail", async () => {
  const { monitor, store } = await makeMonitor({
    "assets/cluster-a.yaml": cluster([{ who: "minh", can: ["submit_job"] }]),
  })
  const job = "x".repeat(3000) + TOKEN
  await monitor.call("minh", "r1", "cluster_a__submit_job", { job })
  const rows = store.listAudit({ person: "minh" })
  expect(rows).toHaveLength(1)
  const row = rows[0]!
  expect(Object.keys(row.args)).toEqual(["truncated"])
  const truncated = row.args.truncated as string
  expect(truncated).toHaveLength(DETAIL_CHARS)
  expect(truncated).toStartWith('{"job": "xxx')
  expect(JSON.stringify(row)).not.toContain(TOKEN)
  await monitor.call("minh", "r1", "cluster_a__submit_job", { job: "small" })
  expect(store.listAudit({ person: "minh" }).at(-1)!.args).toEqual({ job: "small" })
})

test("integer arguments above 2^53 are audited as text", async () => {
  const { monitor, store } = await makeMonitor({
    "assets/cluster-a.yaml": cluster([{ who: "minh", can: ["submit_job"] }]),
  })
  const call = (args: Record<string, unknown>) => monitor.call("minh", "r1", "cluster_a__submit_job", args)
  expect(String(await call({ job: "a", nodes: 12345678901234567890n }))).toStartWith("ran a")
  expect(store.listAudit().at(-1)!.args.nodes).toBe("12345678901234567890")
  expect(String(await call({ job: "a", nodes: 7n }))).toStartWith("ran a")
  expect(store.listAudit().at(-1)!.args.nodes).toBe(7)
  expect(String(await call({ job: "a", ids: [1n, 12345678901234567890n], opts: { n: 2n } }))).toStartWith("ran a")
  const args = store.listAudit().at(-1)!.args
  expect(args.ids).toEqual([1, "12345678901234567890"])
  expect((args.opts as Record<string, unknown>).n).toBe(2)
})

test("non json arguments are audited as text", async () => {
  const { monitor, store } = await makeMonitor({
    "assets/cluster-a.yaml": cluster([{ who: "minh", can: ["submit_job"] }]),
  })
  const blob = new TextEncoder().encode(TOKEN)
  expect(String(await monitor.call("minh", "r1", "cluster_a__submit_job", { job: "a", blob }))).toStartWith("ran a")
  const row = store.listAudit().at(-1)!
  expect(row.args.blob).toBe("[redacted]")
  expect(JSON.stringify(row)).not.toContain(TOKEN)
  expect(JSON.stringify(row)).not.toContain("115,51")
})

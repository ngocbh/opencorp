/** The reference monitor: which asset tools a person gets, and every call's check and audit. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { stringify } from "yaml"
import type { Monitor } from "../../src/perm/monitor.ts"
import { DETAIL_CHARS } from "../../src/perm/redact.ts"
import { person } from "../company/helpers.ts"
import { KINDS, TOKEN, cluster, makeMonitor, setFile } from "./helpers.ts"

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

test("a grant whose where key is proto grants nothing", async () => {
  // A computed key is an own property; a literal `__proto__:` would set the prototype instead.
  const grant = { who: "minh", can: ["submit_job"], where: { ["__proto__"]: ["gpu-small"] } }
  expect(stringify(cluster([grant]))).toContain("__proto__:")
  const { monitor } = await makeMonitor({ "assets/cluster-a.yaml": cluster([grant]) })
  expect(names(monitor, "minh")).toEqual(["fake__echo"])
  expect(await monitor.call("minh", "r1", "cluster_a__submit_job", { job: "x" })).toBe(
    "permission denied: no grant for cluster_a__submit_job",
  )
})

test("a grant whose where holds an integer past the safe range grants nothing", async () => {
  const grant = { who: "minh", can: ["submit_job"], where: { nodes: [9007199254740993n] } }
  expect(stringify(cluster([grant]))).toContain("9007199254740993")
  const { monitor } = await makeMonitor({ "assets/cluster-a.yaml": cluster([grant]) })
  expect(names(monitor, "minh")).toEqual(["fake__echo"])
  for (const nodes of [9007199254740993n, 9007199254740992n])
    expect(await monitor.call("minh", "r1", "cluster_a__submit_job", { job: "x", nodes })).toBe(
      "permission denied: no grant for cluster_a__submit_job",
    )
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

test("a failing tool is an error result without the secret", async () => {
  const { monitor, store } = await makeMonitor({ "assets/cluster-a.yaml": cluster([{ who: "minh", can: ["broken"] }]) })
  const got = await monitor.call("minh", "r1", "cluster_a__broken", {})
  expect(got).toBe("error: RuntimeError: cannot reach host (token [redacted])")
  const rows = store.listAudit()
  expect(rows).toHaveLength(1)
  expect(rows[0]!.outcome).toBe("error")
  expect(rows[0]!.detail).not.toContain(TOKEN)
})

test("a missing secret is an error result", async () => {
  const { monitor, store, secrets } = await makeMonitor({
    "assets/cluster-a.yaml": cluster([{ who: "minh", can: ["read_logs"] }]),
  })
  fs.unlinkSync(path.join(secrets.root, "vault_token"))
  expect(await monitor.call("minh", "r1", "cluster_a__read_logs", {})).toBe("error: secret 'vault_token' is not set")
  expect(store.listAudit()[0]!.outcome).toBe("error")
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

test("an unreadable secret file is an audited error", async () => {
  const { monitor, store, secrets } = await makeMonitor({
    "assets/cluster-a.yaml": cluster([{ who: "minh", can: ["read_logs"] }]),
  })
  const file = path.join(secrets.root, "vault_token")
  fs.chmodSync(file, 0)
  let got: string
  try {
    got = String(await monitor.call("minh", "r1", "cluster_a__read_logs", {}))
  } finally {
    // Restored here: hooks run in order, so an onTestFinished one would run after the temp dir is gone.
    fs.chmodSync(file, 0o600)
  }
  expect(got).toStartWith("error: ")
  expect(got).toContain("vault_token")
  const rows = store.listAudit()
  expect(rows).toHaveLength(1)
  expect(rows[0]!.outcome).toBe("error")
  expect(rows[0]!.detail).toBe(got.slice("error: ".length))
})

test("a directory in place of a secret file is an audited error", async () => {
  const { monitor, store, secrets } = await makeMonitor({
    "assets/cluster-a.yaml": cluster([{ who: "minh", can: ["read_logs"] }]),
  })
  const file = path.join(secrets.root, "vault_token")
  fs.unlinkSync(file)
  fs.mkdirSync(file)
  const got = String(await monitor.call("minh", "r1", "cluster_a__read_logs", {}))
  expect(got).toStartWith("error: ")
  expect(got).toContain("vault_token")
  expect(store.listAudit().map((r) => r.outcome)).toEqual(["error"])
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
  expect(JSON.stringify(row)).not.toContain('"0":115')
})

test("a secret changed between two calls is read on the next", async () => {
  const kinds = {
    ...KINDS,
    cluster: {
      ...KINDS.cluster,
      peek: { run: (_a: unknown, _args: unknown, s: ReadonlyMap<string, string>) => `got ${s.get("vault_token")}` },
    },
  }
  const asset = cluster([{ who: "minh", can: ["submit_job", "peek"] }], { tools: { submit_job: {}, peek: {} } })
  const { monitor, store, secrets } = await makeMonitor({ "assets/cluster-a.yaml": asset }, kinds)
  expect(String(await monitor.call("minh", "r1", "cluster_a__submit_job", { job: "a" }))).toStartWith("ran a")
  const other = "an0ther-t0ken-value"
  await secrets.set("vault_token", other)
  // The kind checks for the old value, so it fails only if the new one was read.
  expect(await monitor.call("minh", "r1", "cluster_a__submit_job", { job: "b" })).toBe("error: RuntimeError: no token")
  expect(await monitor.call("minh", "r1", "cluster_a__peek", {})).toBe("got [redacted]")
  const audit = JSON.stringify(store.listAudit())
  expect(audit).not.toContain(TOKEN)
  expect(audit).not.toContain(other)
})

test("a bigint result holding a digit secret is redacted", async () => {
  const kinds = { ...KINDS, digits: { read: { run: () => ({ code: 12345678901234567890n }) } } }
  const { monitor, store, secrets } = await makeMonitor({
    "assets/vault.yaml": {
      id: "vault", kind: "digits", secrets: ["pin_code"], tools: { read: {} }, grants: [{ who: "minh", can: ["read"] }],
    },
  }, kinds)
  await secrets.set("pin_code", "12345678901234567890")
  expect(await monitor.call("minh", "r1", "vault__read", {})).toEqual({ code: "[redacted]" })
  const rows = store.listAudit()
  expect(rows.map((r) => r.outcome)).toEqual(["ok"])
  expect(JSON.stringify(rows)).not.toContain("12345678901234567890")
})

test("a kind or tool named after an object method is not a tool", async () => {
  const { monitor } = await makeMonitor({
    "assets/odd.yaml": {
      id: "odd", kind: "constructor", tools: { name: {} }, grants: [{ who: "minh", can: ["name"] }],
    },
    "assets/fake2.yaml": {
      id: "fake2", kind: "fake", tools: { toString: {} }, grants: [{ who: "minh", can: ["toString"] }],
    },
  })
  expect(names(monitor, "minh")).toEqual(["fake__echo"])
  expect(await monitor.call("minh", "r1", "odd__name", {})).toBe("error: asset kind 'constructor' has no tool 'name'")
  expect(await monitor.call("minh", "r1", "fake2__toString", {})).toBe(
    "error: asset kind 'fake' has no tool 'toString'",
  )
})

test("a proto key in a result stays a plain key", async () => {
  const kinds = { ...KINDS, odd: { read: { run: () => JSON.parse('{"__proto__": {"t": "s3cr3t-t0ken-value"}}') } } }
  const { monitor } = await makeMonitor({
    "assets/vault.yaml": {
      id: "vault", kind: "odd", secrets: ["vault_token"], tools: { read: {} }, grants: [{ who: "minh", can: ["read"] }],
    },
  }, kinds)
  const got = (await monitor.call("minh", "r1", "vault__read", {})) as object
  expect(Object.hasOwn(got, "__proto__")).toBe(true)
  expect(Object.getOwnPropertyDescriptor(got, "__proto__")!.value).toEqual({ t: "[redacted]" })
})

test("a shared value in a result is not a cycle", async () => {
  const shared = { t: "x" }
  const kinds = { ...KINDS, odd: { read: { run: () => ({ a: shared, b: shared }) } } }
  const { monitor, store } = await makeMonitor({
    "assets/vault.yaml": {
      id: "vault", kind: "odd", secrets: ["vault_token"], tools: { read: {} }, grants: [{ who: "minh", can: ["read"] }],
    },
  }, kinds)
  expect(await monitor.call("minh", "r1", "vault__read", {})).toEqual({ a: { t: "x" }, b: { t: "x" } })
  expect(store.listAudit().map((r) => r.outcome)).toEqual(["ok"])
})

test("a hole in a result array is null", async () => {
  const kinds = { ...KINDS, odd: { holes: { run: () => [1, , 3] } } }
  const { monitor, store } = await makeMonitor({
    "assets/vault.yaml": {
      id: "vault",
      kind: "odd",
      secrets: ["vault_token"],
      tools: { holes: {} },
      grants: [{ who: "minh", can: ["holes"] }],
    },
  }, kinds)
  expect(await monitor.call("minh", "r1", "vault__holes", {})).toStrictEqual([1, null, 3])
  expect(store.listAudit().map((r) => r.outcome)).toEqual(["ok"])
})

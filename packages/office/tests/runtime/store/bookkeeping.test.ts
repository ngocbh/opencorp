/** Audit, usage, and worker rows (office bookkeeping, no events). */
import { expect, test } from "bun:test"
import { openStore, recordEvents } from "./helpers.ts"

test("audit rows", () => {
  const store = openStore()
  const events = recordEvents(store)
  const a = store.recordAudit({
    person: "minh",
    kind: "asset",
    tool: "cluster_a__ssh",
    args: { host: "x" },
    outcome: "ok",
    sessionId: "s1",
    runId: "r1",
  })
  const b = store.recordAudit({
    person: "minh",
    kind: "workspace",
    tool: "shell",
    args: { cmd: "ls" },
    outcome: "denied",
    sessionId: "s2",
    detail: "where",
  })
  expect(store.listAudit()).toEqual([a, b])
  expect(store.listAudit({ sessionId: "s2" })).toEqual([b])
  expect(store.listAudit({ person: "lan" })).toEqual([])
  expect(events).toEqual([])
})

test("usage rows and total", () => {
  const store = openStore()
  const events = recordEvents(store)
  const a = store.recordUsage({ sessionId: "s1", runId: "r1", model: "m", usd: 0.25 })
  store.recordUsage({ sessionId: "s1", runId: "r1", model: "m", usd: 0.5 })
  store.recordUsage({ sessionId: "s2", runId: "r2", model: "m", usd: 9 })
  expect(store.listUsage("s1")[0]).toEqual(a)
  expect(store.listUsage("s1")).toHaveLength(2)
  expect(store.sessionUsageUsd("s1")).toBe(0.75)
  expect(store.sessionUsageUsd("none")).toBe(0)
  expect(events).toEqual([])
})

test("worker rows", () => {
  const store = openStore()
  store.recordWorker("s1", { pid: 100, pgid: 100, startTime: 1.5 })
  store.recordWorker("s2", { pid: 200, pgid: 200, startTime: 2.5 })
  store.recordWorker("s1", { pid: 101, pgid: 101, startTime: 3.5 })
  expect(store.listWorkers().map((w) => [w.key, w.pid, w.startTime])).toEqual([
    ["s1", 101, 3.5],
    ["s2", 200, 2.5],
  ])
  store.removeWorker("s1")
  store.removeWorker("s1")
  expect(store.listWorkers().map((w) => w.key)).toEqual(["s2"])
  // Another process's record under the same key stays.
  store.removeWorker("s2", 999)
  expect(store.listWorkers().map((w) => w.key)).toEqual(["s2"])
  store.removeWorker("s2", 200)
  expect(store.listWorkers()).toEqual([])
})

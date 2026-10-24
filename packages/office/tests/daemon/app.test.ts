/** The office: its paths, and start and stop. */
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { OfficePaths, type WorkerPool } from "../../src/daemon/office.ts"
import { allRoutes } from "../../src/daemon/routes/index.ts"
import { tempDir } from "../helpers.ts"
import { makeOffice, request, served, ULID } from "./helpers.ts"

setDefaultTimeout(30_000)

/** A WorkerPool that counts closeAll calls. */
class FakePool implements WorkerPool {
  closed = 0

  closeAll(): void {
    this.closed++
  }
}

class StopFailed extends Error {}

test("paths layout", () => {
  const home = tempDir()
  const p = new OfficePaths(home)
  expect(p.company).toBe(path.join(home, "company"))
  expect(p.store).toBe(path.join(home, "office", "store.sqlite"))
  expect(p.socket).toBe(path.join(home, "office", "office.sock"))
  expect(p.pidfile).toBe(path.join(home, "office", "office.pid"))
  expect(p.worktrees).toBe(path.join(home, "office", "worktrees"))
  expect(p.runDir("S1")).toBe(path.join(home, "office", "runs", "S1"))
  expect([p.memory, p.secrets]).toEqual([path.join(home, "office", "memory"), path.join(home, "office", "secrets")])
})

test("start and stop run callbacks and close workers", async () => {
  const office = makeOffice()
  const calls: string[] = []
  const pool = new FakePool()
  office.workers = pool
  office.onStart.push(
    () => calls.push("s1"),
    async () => {
      calls.push("s2")
    },
  )
  office.onStop.push(
    () => calls.push("t1"),
    () => calls.push("t2"),
  )
  await office.start()
  await office.stop()
  expect(calls).toEqual(["s1", "s2", "t2", "t1"])
  expect(pool.closed).toBe(1)
})

test("failed start stops the office", async () => {
  const office = makeOffice()
  const calls: string[] = []
  const pool = new FakePool()
  office.workers = pool
  office.onStart.push(
    () => calls.push("s1"),
    () => {
      throw new Error("no model key")
    },
  )
  office.onStop.push(() => calls.push("t1"))
  await expect(office.start()).rejects.toThrow("no model key")
  expect(calls).toEqual(["s1", "t1"])
  expect(pool.closed).toBe(1)
  expect(await office.bus.subscribe().next(1000)).toBeNull() // the bus is closed
})

test("a failing stop callback does not skip the rest", async () => {
  const lines: string[] = []
  const office = makeOffice({ log: (message) => lines.push(message) })
  const calls: string[] = []
  const fail = (what: string) => () => {
    calls.push(what)
    throw new StopFailed(what)
  }
  office.onStart.push(() => calls.push("a start"), fail("b start"))
  office.onStop.push(
    () => calls.push("a stop"),
    () => calls.push("b stop"),
    fail("c stop"),
  )
  await expect(office.start()).rejects.toThrow("b start")
  expect(calls).toEqual(["a start", "b start", "c stop", "b stop", "a stop"])
  // The type only: an error's message can quote a secret.
  expect(lines).toEqual(["office on_stop callback failed: StopFailed"])
})

// [method, route pattern] for the routes that stream; GET /events is tested over a socket in
// routes_events.test.ts.
const STREAMS: [string, string][] = [["GET", "/events"]]

// [method, route pattern, concrete path, body] for every other route; null is no body. Python's table
// (tests/daemon/test_app.py) also covered these routes; each is added here when its route area is ported:
// - sessions: GET and POST /sessions, GET /sessions/:id, GET /sessions/:id/messages, and POST /sessions/:id/
//   prompt, steer, interrupt, end, continue, cost-cap and model;
// - questions: GET /questions, GET /questions/:id, and POST /questions/:id/ answer, side, send-back, stop and
//   carried/dismiss.
// GET /health, GET /office, GET /whoami, the device routes, GET /costs and the GET /runs* stubs weren't in
// Python's table.
const TABLE: [string, string, string, unknown][] = [
  ["GET", "/health", "/health", null],
  ["GET", "/office", "/office", null],
  ["GET", "/whoami", "/whoami", null],
  ["POST", "/people/:handle/devices", "/people/ngocbh/devices", { name: "mac", token_sha256: "a".repeat(64) }],
  ["DELETE", "/people/:handle/devices/:name", "/people/ngocbh/devices/pc", null],
  ["POST", "/login", "/login", { handle: "ngocbh", password: "x", device: "mac", token_sha256: "b".repeat(64) }],
  ["PUT", "/people/:handle/password", "/people/ngocbh/password", { password: "a-long-enough-password" }],
  ["GET", "/people", "/people", null],
  ["POST", "/people", "/people", { name: "Ava", handle: "ava", title: "R", manager: "ngocbh" }],
  ["GET", "/folders/*cwd/people", "/folders/%2Fw%2Fapp/people", null],
  ["GET", "/work-items/:id", `/work-items/${ULID}`, null],
  ["GET", "/work-items/:id/comments", `/work-items/${ULID}/comments`, null],
  ["GET", "/profiles/:handle", "/profiles/minh", null],
  ["PUT", "/profiles/:handle", "/profiles/minh", { text: "x", base_version: "a".repeat(40) }],
  ["GET", "/costs", "/costs?since=2026-01-01T00:00:00Z", null],
  ["GET", "/runs", "/runs", null],
  ["GET", "/runs/:id", "/runs/R1", null],
  ["GET", "/runs/:id/nodes", "/runs/R1/nodes", null],
  ["GET", "/runs/:id/events", "/runs/R1/events", null],
  ["GET", "/runs/:id/events/:seq", "/runs/R1/events/3", null],
  ["GET", "/runs/:id/log", "/runs/R1/log", null],
]

test("every table route is served", async () => {
  const listed = new Set([...STREAMS, ...TABLE].map(([method, pattern]) => `${method} ${pattern}`))
  expect(new Set(allRoutes().map((r) => `${r.method} ${r.path}`))).toEqual(listed)
  const office = makeOffice()
  const { sock } = await served(office)
  for (const [method, , target, body] of TABLE) {
    const r = await request(
      sock,
      method,
      target,
      body === null ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    )
    expect(r.headers["content-type"]).toStartWith("application/json")
    if (r.status >= 400) expect(["no_route", "method_not_allowed"]).not.toContain((r.json() as { error: string }).error)
  }
})

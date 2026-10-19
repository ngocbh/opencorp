import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import type { CompanyView } from "@opencorp/protocol"
import { createOfficeClient } from "../src/client"
import { applyCompany, emptyState } from "../src/store"
import { onStop, serve, stopServers } from "./serve"

afterEach(stopServers)

test("the browser client's HQ reads and writes hit /api", async () => {
  const { seen, base } = serve()
  const c = createOfficeClient({ baseUrl: base })
  await c.company.get()
  await c.costs.since("2026-10-19T00:00:00.000Z")
  await c.health()
  await c.pair({ code: "abc", label: "Safari" })
  await c.logout()
  await c.sessions.list({ status: ["busy", "idle"], limit: 500 })
  expect(seen.map((s) => `${s.method} ${s.path}${s.query}`)).toEqual([
    "GET /api/company",
    "GET /api/costs?since=2026-10-19T00%3A00%3A00.000Z",
    "GET /api/health",
    "POST /api/pair",
    "POST /api/logout",
    "GET /api/sessions?limit=500&status=busy%2Cidle",
  ])
  expect(seen.find((s) => s.path === "/api/logout")?.body).toBe("{}")
})

test("the socket client's HQ routes, and health's plain answer there", async () => {
  const dir = mkdtempSync("/tmp/oct-")
  onStop(() => rmSync(dir, { recursive: true, force: true }))
  const { seen } = serve({ unix: path.join(dir, "o.sock") })
  const c = createOfficeClient({ socket: path.join(dir, "o.sock") })
  await c.hq.status()
  await c.hq.pair({ handle: null, open_file: true })
  await c.hq.browsers("ann")
  await c.hq.removeBrowser("01JA")
  const health = await c.health()
  // The socket's /health has no compatibility keys; only HQ's /api/health does. The typecheck runs this line too:
  // the plain answer must be a value health() can return.
  const plain: Awaited<ReturnType<typeof c.health>> = { ok: true }
  expect(health).toEqual(plain)
  expect(seen.map((s) => `${s.method} ${s.path}${s.query}`)).toEqual([
    "GET /hq",
    "POST /hq/pair",
    "GET /hq/browsers?person=ann",
    "DELETE /hq/browsers/01JA",
    "GET /health",
  ])
})

test("applyCompany sets people, groups, the company, the sha and the issues from one view", () => {
  const s = emptyState()
  const view = {
    sha: "a".repeat(40),
    company: { name: "Acme", ceo: "ngocbh" },
    people: [],
    groups: [],
    issues: [],
  } as unknown as CompanyView
  applyCompany(s, view)
  expect([s.company?.name, s.sha, s.groups, s.issues, s.costs]).toEqual(["Acme", "a".repeat(40), [], [], null])
})

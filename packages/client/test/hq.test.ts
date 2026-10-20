import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import type { CompanyFile, CompanyTree, CompanyView } from "@opencorp/protocol"
import { createOfficeClient } from "../src/client"
import { isBadPath, isMissingRoute, isNoFile, isStaleCommit, OfficeError } from "../src/errors"
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
  await c.signIn({ handle: "ann", password: "pw", label: "Safari on Mac" })
  await c.logout()
  await c.sessions.list({ status: ["busy", "idle"], limit: 500 })
  expect(seen.map((s) => `${s.method} ${s.path}${s.query}`)).toEqual([
    "GET /api/company",
    "GET /api/costs?since=2026-10-19T00%3A00%3A00.000Z",
    "GET /api/health",
    "POST /api/pair",
    "POST /api/login",
    "POST /api/logout",
    "GET /api/sessions?limit=500&status=busy%2Cidle",
  ])
  expect(seen.find((s) => s.path === "/api/logout")?.body).toBe("{}")
  const login = seen.find((s) => s.path === "/api/login")!
  expect([login.type, JSON.parse(login.body)]).toEqual([
    "application/json",
    { handle: "ann", password: "pw", label: "Safari on Mac" },
  ])
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

const AT = "b".repeat(40)

const failure = (p: Promise<unknown>): Promise<any> =>
  p.then(
    () => {
      throw new Error("expected the request to fail")
    },
    (e) => e,
  )

test("the Source reads hit /api/company/tree and /api/company/file with at and path as query params", async () => {
  const { seen, base } = serve()
  const c = createOfficeClient({ baseUrl: base })
  await c.company.tree()
  await c.company.file(AT, "people/nguyen/person.yaml")
  expect(seen.map((s) => `${s.method} ${s.path}${s.query}`)).toEqual([
    "GET /api/company/tree",
    `GET /api/company/file?at=${AT}&path=people%2Fnguyen%2Fperson.yaml`,
  ])
})

test("an odd path reaches the office as written, in one query param", async () => {
  const { seen, base } = serve()
  const c = createOfficeClient({ baseUrl: base })
  const odd = ["notes/a b+c&d=e#f?g.md", "100%/x;y,z'\"<>.txt", "người/hồ sơ.yaml", "../../etc/passwd", "a/b/../c"]
  for (const p of odd) await c.company.file(AT, p)
  const got = seen.map((s) => new URLSearchParams(s.query))
  expect(got.map((q) => [...q.keys()])).toEqual(odd.map(() => ["at", "path"]))
  expect(got.map((q) => [q.get("at"), q.get("path")])).toEqual(odd.map((p) => [AT, p]))
  // The path stays in the query: nothing in it changes the route the office sees.
  expect(seen.every((s) => s.path === "/api/company/file")).toBe(true)
})

test("the Source reads return the office's tree and file as sent", async () => {
  const tree: CompanyTree = {
    commit: { id: AT, subject: "Hire nguyen", author: "Ngoc Bui", time: "2026-10-20T00:00:00.000Z" },
    entries: [
      { path: "people", type: "folder", size: null },
      { path: "people/nguyen/person.yaml", type: "file", size: 120 },
    ],
    truncated: false,
    skipped: 0,
  }
  const file: CompanyFile = { path: "people/nguyen/person.yaml", commit: AT, content: "text", text: "handle: nguyen\n" }
  const { base } = serve({
    answer: (req) => Response.json(new URL(req.url).pathname.endsWith("/tree") ? tree : file),
  })
  const c = createOfficeClient({ baseUrl: base })
  expect(await c.company.tree()).toEqual(tree)
  expect(await c.company.file(AT, file.path)).toEqual(file)
})

test("a file read's 409 stale_commit, 404 no_file and 400 bad_path are errors the app can tell apart", async () => {
  const answers: Record<string, [number, string]> = {
    stale: [409, "stale_commit"],
    gone: [404, "no_file"],
    bad: [400, "bad_path"],
    old: [404, "no_route"],
  }
  const { base } = serve({
    answer: (req) => {
      const [status, error] = answers[new URL(req.url).searchParams.get("path")!]!
      return Response.json({ error, message: `${error} here` }, { status })
    },
  })
  const c = createOfficeClient({ baseUrl: base })
  const errors = await Promise.all(Object.keys(answers).map((p) => failure(c.company.file(AT, p))))
  expect(errors.every((e) => e instanceof OfficeError)).toBe(true)
  expect(errors.map((e) => [e.status, e.code, e.message])).toEqual(
    Object.values(answers).map(([status, code]) => [status, code, `${code} here`]),
  )
  // Each predicate matches its own error only: an office older than the route (404 no_route) isn't a missing file.
  const checks = [isStaleCommit, isNoFile, isBadPath, isMissingRoute]
  expect(errors.map((e) => checks.map((f) => f(e)))).toEqual(checks.map((_, i) => checks.map((_, j) => i === j)))
  expect([
    isStaleCommit(undefined),
    isNoFile(new Error("no_file")),
    isBadPath(new OfficeError(409, "bad_path", "bad_path")),
  ]).toEqual([false, false, false])
})

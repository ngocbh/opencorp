import { expect, test } from "@playwright/test"

test.beforeEach(async ({ request }) => void (await request.post("/__fixture/reset")))

test("the fixture gates /api on a session, spends a code once, logs calls, and can drop the office", async ({ request }) => {
  expect((await request.get("/api/health")).status()).toBe(200)
  expect((await request.get("/api/company")).status()).toBe(401)
  await request.post("/__fixture/code", { data: { code: "c1" } })
  expect((await request.post("/api/pair", { data: { code: "c1", label: "x" } })).status()).toBe(200)
  expect((await request.post("/api/pair", { data: { code: "c1" } })).status()).toBe(400)
  expect((await (await request.get("/api/company")).json()).company.name).toBe("Acme")
  expect((await (await request.get("/api/questions/Q1")).json()).error).toBe("no_route") // as HQ's allowlist
  const log = await (await request.get("/__fixture/log")).json()
  expect(log.pairs).toEqual([{ code: "c1", label: "x" }, { code: "c1" }])
  expect(log.api).toContain("/api/questions/Q1")
  await request.post("/__fixture/drop", { data: { ms: 300 } })
  expect((await request.get("/api/company")).status()).toBe(503)
})

test("static files: a malformed path is a page like any other, and only GET and HEAD get index.html", async ({ request }) => {
  // As the office: uvicorn decodes a path leniently, keeping an escape it can't read.
  const malformed = await request.get("/%E0%A4%A", { headers: { "sec-fetch-dest": "document" } })
  expect([malformed.status(), malformed.headers()["content-type"]]).toEqual([200, expect.stringContaining("text/html")])
  expect((await request.get("/assets/%E0%A4%A.js")).status()).toBe(404)
  expect((await request.get("/some/page")).status()).toBe(200)
  expect((await request.head("/some/page")).status()).toBe(200)
  const post = await request.post("/some/page", { data: {} })
  expect([post.status(), post.headers()["allow"], (await post.json()).error]).toEqual([405, "GET, HEAD", "method_not_allowed"])
})

test("Acme: six people, two groups, a broken file, three live sessions, two cards, costs", async ({ request }) => {
  await request.post("/__fixture/set", { data: { signedIn: true } })
  const view = await (await request.get("/api/company")).json()
  expect(view.people.map((p: { handle: string }) => p.handle)).toEqual(["ngocbh", "lead", "minh", "kai", "ann", "zoe"])
  expect([view.groups.length, view.issues[0].path]).toEqual([2, "people/bad/person.yaml"])
  expect((await (await request.get("/api/sessions")).json()).length).toBe(3)
  expect((await (await request.get("/api/questions")).json()).map((q: { id: string }) => q.id)).toEqual(["Q-kai", "Q-lead"])
  expect((await (await request.get("/api/costs?since=x")).json()).people.minh).toEqual({ usd: 0, unpriced_sessions: 1 })
})

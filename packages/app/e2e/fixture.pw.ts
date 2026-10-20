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

test("static files: a malformed path is a 404, and only GET and HEAD get index.html", async ({ request }) => {
  expect((await request.get("/%E0%A4%A")).status()).toBe(404)
  expect((await request.get("/some/page")).status()).toBe(200)
  expect((await request.head("/some/page")).status()).toBe(200)
  expect((await request.post("/some/page", { data: {} })).status()).toBe(405)
})

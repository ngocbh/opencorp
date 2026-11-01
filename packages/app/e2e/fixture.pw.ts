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

test("the fixture's /api/login: one 401 for every failure, 429 with Retry-After, 503, and a session cookie", async ({ request }) => {
  const login = (data: unknown) => request.post("/api/login", { data })
  for (const body of [
    { handle: "ngocbh", password: "wrong" },
    { handle: "nobody", password: "correct horse" },
    { handle: "minh", password: "correct horse" }, // an agent: never a password
  ]) {
    const r = await login(body)
    expect([r.status(), await r.json()]).toEqual([401, { error: "bad_credentials", message: "wrong handle or password" }])
  }
  expect((await login({ handle: "@NgocBH", password: "x" })).status()).toBe(422)
  expect((await login({ handle: "ngocbh", password: "" })).status()).toBe(422)
  expect((await login({ handle: "ngocbh", password: "x", label: 5 })).status()).toBe(422)
  expect((await login({ handle: "ngocbh", password: "x", label: "x".repeat(101) })).status()).toBe(422)
  expect((await login({ handle: "ngocbh", password: "x", extra: 1 })).status()).toBe(422)
  expect((await login({ handle: "ngocbh", password: "x", label: null })).status()).toBe(401)
  expect((await request.get("/api/company")).status()).toBe(401)
  await request.post("/__fixture/set", { data: { login: { retryAfter: 600, busy: false } } })
  const limited = await login({ handle: "ngocbh", password: "correct horse" })
  expect([limited.status(), limited.headers()["retry-after"], (await limited.json()).error]).toEqual([429, "600", "too_many_attempts"])
  await request.post("/__fixture/set", { data: { login: { retryAfter: null, busy: true } } })
  const busy = await login({ handle: "ngocbh", password: "correct horse" })
  expect([busy.status(), (await busy.json()).error]).toEqual([503, "busy"])
  await request.post("/__fixture/set", { data: { login: { retryAfter: null, busy: false } } })
  const ok = await login({ handle: "ngocbh", password: "correct horse", label: "Chrome on Mac" })
  expect(ok.status()).toBe(200)
  expect(ok.headers()["set-cookie"]).toMatch(/^opencorp_hq_\d+_[0-9a-f]{32}=fixture; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000/)
  expect(await ok.json()).toMatchObject({ person: "ngocbh", via: "login", issued_by: "ngocbh", label: "Chrome on Mac" })
  expect((await request.get("/api/company")).status()).toBe(200)
  const log = await (await request.get("/__fixture/log")).json()
  expect(log.logins.at(-1)).toEqual({ handle: "ngocbh", label: "Chrome on Mac" })
  expect(JSON.stringify(log)).not.toContain("correct horse") // the fixture never keeps a password
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

test("the fixture's /api/runs?recent=: open runs of any age or launched since, never with since or until", async ({ request }) => {
  await request.post("/__fixture/set", { data: { signedIn: true } })
  const recent = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const now = new Date().toISOString()
  const parent = "01JA1H00000000000000000005"
  const ids = async (query: string) =>
    ((await (await request.get(`/api/runs?${query}`)).json()).runs as { run_id: string }[]).map((r) => r.run_id.slice(-1))
  expect(await ids(`recent=${recent}`)).toEqual(["5", "4", "3", "2", "1"])
  expect(await ids(`recent=${now}`)).toEqual(["5", "3"]) // every run started earlier: only the open ones
  expect(await ids(`parent=${parent}&recent=${recent}`)).toEqual(["6"])
  expect(await ids(`parent=${parent}&recent=${now}`)).toEqual([])
  for (const query of [`recent=${recent}&since=${recent}`, `recent=${recent}&until=${now}`, "recent=x",
                       `parent=${parent}&recent=${recent}&until=${now}`])
    expect((await request.get(`/api/runs?${query}`)).status()).toBe(422)
})

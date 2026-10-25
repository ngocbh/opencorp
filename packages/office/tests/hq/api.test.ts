/** HQ's /api: the allowlist. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { parse, stringify } from "yaml"
import { hashPassword } from "../../src/auth/passwords.ts"
import { SECRET_KEYS } from "../../src/company/secret_keys.ts"
import { git } from "../company/helpers.ts"
import { CEO, makeOffice, parse as parseReply, raw } from "../daemon/helpers.ts"
import { question, session, workItem } from "../store/helpers.ts"
import { HOST, ORIGIN, PORT, dist, makeHq, signedIn, web } from "./helpers.ts"

type Body = Record<string, unknown>
type PersonBody = { devices: unknown[]; password_hash: string | null; skills: string[] }

test("health is open and says both keys", async () => {
  const office = makeOffice()
  dist(office.paths.home)
  const hq = await makeHq(office)
  const r = await (await web(hq)).get("/api/health")
  expect(r.status).toBe(200)
  expect(r.json()).toEqual({ ok: true, office: { api: hq.api }, app: { build: "b1", api: "x" } })
})

test("anything else under api needs a session first", async () => {
  const r = await (await web(await makeHq(makeOffice()))).get("/api/people")
  expect(r.status).toBe(401)
  expect((r.json() as { error: string }).error).toBe("sign_in_required")
})

test("anything else under api is a json 404", async () => {
  const hq = await makeHq(makeOffice())
  const client = await web(hq)
  const [, cookie] = await hq.sessions.issue(CEO, { issuedBy: CEO, label: null })
  client.cookies.set(`opencorp_hq_${PORT}`, cookie)
  for (const target of ["/api", "/api/people", "/api/hq/pair", "/api/hq/browsers"]) {
    const r = await client.get(target)
    expect([r.status, (r.json() as Body).error, target]).toEqual([404, "no_route", target])
  }
})

test("company is the head snapshot without devices", async () => {
  const office = makeOffice()
  const hq = await makeHq(office)
  const client = await signedIn(hq)
  const file = path.join(office.paths.company, "people", CEO, "person.yaml")
  const data = parse(fs.readFileSync(file, "utf8")) as Body
  data.devices = [{ name: "mac", token_sha256: "a".repeat(64) }] // a device, not a password: the session lives on
  fs.writeFileSync(file, stringify(data))
  git(office.paths.company, "commit", "-qam", "a device")
  const r = await client.get("/api/company")
  const body = r.json() as {
    sha: string
    company: { ceo: string }
    people: PersonBody[]
    groups: { id: string }[]
    issues: unknown[]
  }
  expect(r.status).toBe(200)
  expect(body.sha).toBe(await office.git.head())
  expect(body.company.ceo).toBe(CEO)
  for (const p of body.people) {
    expect(p.devices).toEqual([])
    expect(p.password_hash).toBeNull()
  }
  expect(body.groups.map((g) => g.id)).toEqual(["eng"])
  expect(body.issues).toEqual([])
})

test("company strips devices and password hashes whatever the snapshot holds", async () => {
  // The snapshot strips them already; the handler strips them again, since the reply goes to a browser.
  const hq = await makeHq(makeOffice())
  const client = await signedIn(hq)
  const view = (await hq.snapshots.head())!
  const hash = await hashPassword("a secret")
  const leaky = {
    ...view,
    people: view.people.map((p) => ({
      ...p,
      devices: [{ name: "mac", token_sha256: "a".repeat(64) }],
      password_hash: hash,
    })),
  }
  hq.snapshots.head = async () => leaky
  const r = await client.get("/api/company")
  const people = (r.json() as { people: PersonBody[] }).people
  expect(r.status).toBe(200)
  expect(people.length).toBeGreaterThan(0)
  for (const p of people) {
    expect(p.devices).toEqual([])
    expect(p.password_hash).toBeNull()
  }
  expect(r.text).not.toContain("token_sha256")
  expect(r.text).not.toContain("$scrypt$")
})

test("company blanks by secret keys", async () => {
  const hq = await makeHq(makeOffice())
  const client = await signedIn(hq)
  const view = await hq.snapshots.head()
  // Loaded before the change, so only the handler can blank them.
  expect(view!.people.some((p) => p.skills.length > 0)).toBe(true)
  const keys = SECRET_KEYS as Set<string>
  keys.add("skills")
  try {
    const r = await client.get("/api/company")
    expect(r.status).toBe(200)
    for (const p of (r.json() as { people: PersonBody[] }).people) expect(p.skills).toEqual([])
  } finally {
    keys.delete("skills")
  }
})

test("open questions a work item and costs", async () => {
  const office = makeOffice()
  const hq = await makeHq(office)
  const client = await signedIn(hq)
  const s = office.store.createSession(session())
  const q = office.store.addQuestion(question(s.id))
  const item = office.store.createWorkItem(workItem({ assignee: CEO }))
  const open = await client.get("/api/questions", { query: { status: "open" } })
  expect((open.json() as Body[]).map((x) => x.id)).toEqual([q.id])
  expect(((await client.get(`/api/work-items/${item.id}`)).json() as Body).assignee).toBe(CEO)
  const r = await client.get("/api/costs", { query: { since: "2026-10-19T00:00:00.000Z" } })
  expect(r.status).toBe(200)
  expect((r.json() as Body).since).toBe("2026-10-19T00:00:00.000Z")
})

test.each(["/api/people", "/api/sessions/X/messages", "/api/connections", "/api/hq"])(
  "routes off the allowlist are a json 404 [%s]",
  async (target) => {
    const r = await (await signedIn(await makeHq(makeOffice()))).get(target)
    expect(r.status).toBe(404)
    expect((r.json() as Body).error).toBe("no_route")
  },
)

test("writes off the allowlist are a json 404", async () => {
  const client = await signedIn(await makeHq(makeOffice()))
  for (const target of ["/api/sessions", "/api/people", "/api/questions/X/answer"])
    expect([(await client.post(target, {})).status, target]).toEqual([404, target])
})

test("get office isnt on the hq allowlist", async () => {
  const office = makeOffice()
  dist(office.paths.home)
  const client = await signedIn(await makeHq(office))
  const r = await client.get("/api/office")
  expect(r.status).toBe(404)
  expect((r.json() as Body).error).toBe("no_route")
  const page = await client.get("/office", { headers: { "sec-fetch-dest": "document" } })
  expect(page.status).toBe(200)
  expect(page.headers["content-type"]).toStartWith("text/html")
  expect(page.text).toBe(fs.readFileSync(path.join(office.paths.home, "dist", "index.html"), "utf8"))
  expect(page.text).not.toContain("pid")
  expect(page.text).not.toContain("home")
})

test("a wrong method under api is a json 404", async () => {
  const client = await signedIn(await makeHq(makeOffice()))
  const cookie = [...client.cookies].map(([name, value]) => `${name}=${value}`).join("; ")
  for (const [method, target] of [
    ["POST", "/api/health"],
    ["DELETE", "/api/company"],
  ]) {
    // Raw: under `bun test` the node:http client drops a DELETE's body.
    const head = [`${method} ${target} HTTP/1.1`, `host: ${HOST}`, `origin: ${ORIGIN}`, `cookie: ${cookie}`]
    const sent = [...head, "content-type: application/json", "content-length: 2", "connection: close"]
    const r = parseReply((await raw(client.sock, `${sent.join("\r\n")}\r\n\r\n{}`)).text)
    expect([r.status, (JSON.parse(r.body) as Body).error, target]).toEqual([404, "no_route", target])
    expect(r.head.toLowerCase()).not.toContain("\r\nallow:")
  }
})

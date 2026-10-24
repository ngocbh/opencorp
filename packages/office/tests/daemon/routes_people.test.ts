/** People routes. */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { stringify } from "yaml"
import { makeOffice, request, served } from "./helpers.ts"

setDefaultTimeout(30_000)

const HIRE = { name: "Ava", handle: "ava", title: "R", manager: "ngocbh" }

type Reply = Awaited<ReturnType<typeof request>>
type Hired = { person: Record<string, unknown>; diff: string; issues: unknown[]; commit: string | null }
type Served = { handle: string; password_hash: string | null }

function folder(cwd: string): string {
  return `/folders/${encodeURIComponent(cwd)}/people`
}

function post(sock: string, body: unknown): Promise<Reply> {
  return request(sock, "POST", "/people", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const handles = (reply: Reply) => (reply.json() as Served[]).map((p) => p.handle)
const errorOf = (reply: Reply) => (reply.json() as { error: string }).error

test("hire previews then commits", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const company = office.paths.company
  const head = await office.git.head()
  let r = await post(sock, HIRE)
  expect(r.status).toBe(200)
  const preview = r.json() as Hired
  expect(preview.commit).toBeNull()
  expect(preview.issues).toEqual([])
  expect(preview.person).not.toHaveProperty("id")
  expect(preview.diff).toContain("b/people/ava/person.yaml")
  expect(await office.git.head()).toBe(head)
  expect(fs.existsSync(path.join(company, "people/ava"))).toBe(false)
  r = await post(sock, { ...HIRE, confirm: true })
  expect(r.status).toBe(200)
  const newHead = await office.git.head()
  expect((r.json() as Hired).commit).toBe(newHead)
  expect(newHead).not.toBe(head)
  expect(fs.readdirSync(path.join(company, "people/ava")).sort()).toEqual(["person.yaml", "profile.md"])
  expect(handles(await request(sock, "GET", "/people"))).toContain("ava")
})

test("a confirm without a preview is refused", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const head = await office.git.head()
  const r = await post(sock, { ...HIRE, confirm: true })
  expect([r.status, errorOf(r), await office.git.head()]).toEqual([422, "lint_failed", head])
})

test("a hire with lint errors previews but does not confirm", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const head = await office.git.head()
  let r = await post(sock, { ...HIRE, manager: "ghost" })
  expect(r.status).toBe(200)
  const issues = (r.json() as { issues: { path: string; code: string; severity: string }[] }).issues
  expect(issues.map((i) => [i.path, i.code, i.severity])).toEqual([
    ["people/ava/person.yaml", "person.unknown_manager", "error"],
  ])
  r = await post(sock, { ...HIRE, manager: "ghost", confirm: true })
  expect([r.status, r.json()]).toEqual([422, { error: "lint_failed", message: "ghost" }])
  r = await post(sock, { ...HIRE, title: "Lead", confirm: true })
  expect([r.status, errorOf(r)]).toEqual([422, "lint_failed"])
  expect(await office.git.head()).toBe(head)
})

test("a taken handle is a lint error", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const head = await office.git.head()
  let r = await post(sock, { ...HIRE, handle: "minh" })
  expect(r.status).toBe(200)
  expect((r.json() as Hired).issues).toEqual([
    {
      path: "people/minh/person.yaml",
      code: "person.duplicate_handle",
      message: "@minh is already taken",
      severity: "error",
    },
  ])
  r = await post(sock, { ...HIRE, handle: "minh", confirm: true })
  expect([r.status, r.json()]).toEqual([422, { error: "lint_failed", message: "@minh is already taken" }])
  expect(await office.git.head()).toBe(head)
})

const { title: _title, ...UNTITLED } = HIRE

test.each([
  ["no title", UNTITLED, "title: is required"],
  ["handle Ava", { ...HIRE, handle: "Ava" }, "handle: isn't in the right format"],
  ["kind", { ...HIRE, kind: "human" }, "an extra field: isn't allowed"],
  ["id", { ...HIRE, id: "ava" }, "an extra field: isn't allowed"],
])("a malformed hire is invalid body [%s]", async (_case, body, message) => {
  const office = makeOffice()
  const { sock } = await served(office)
  const head = await office.git.head()
  const r = await post(sock, body)
  expect([r.status, r.json()]).toEqual([422, { error: "invalid_body", message }])
  for (const echoed of ["Ava", "human", "'ava'", '"ava"']) expect(r.text).not.toContain(echoed)
  expect(await office.git.head()).toBe(head)
})

test("people lists the roster", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const r = await request(sock, "GET", "/people")
  expect(r.status).toBe(200)
  expect(handles(r)).toEqual(["minh", "ngocbh"])
})

test("people shows an uncommitted hand edit", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const dir = path.join(office.paths.company, "people/ava")
  fs.mkdirSync(dir)
  fs.writeFileSync(
    path.join(dir, "person.yaml"),
    stringify({ handle: "ava", name: "Ava", kind: "agent", title: "R", manager: "ngocbh" }),
  )
  expect(handles(await request(sock, "GET", "/people"))).toContain("ava")
})

test("folder people most recent first", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const s = office.store
  s.touchWorkedFolder("ngocbh", "/w/my app", "2026-09-01T00:00:00.000Z")
  s.touchWorkedFolder("minh", "/w/my app", "2026-09-02T00:00:00.000Z")
  s.touchWorkedFolder("minh", "/w/other", "2026-09-03T00:00:00.000Z")
  s.touchWorkedFolder("ghost", "/w/my app", "2026-09-04T00:00:00.000Z") // not in the repo
  const file = path.join(office.paths.company, "people/ngocbh/person.yaml")
  fs.writeFileSync(file, `${fs.readFileSync(file, "utf8")}password_hash: "$scrypt$ln=15,r=8,p=1$c2FsdA$aGFzaA"\n`)
  const r = await request(sock, "GET", folder("/w/my app"))
  expect(r.status).toBe(200)
  expect(handles(r)).toEqual(["minh", "ngocbh"])
  expect(r.text).not.toContain("scrypt")
  expect((r.json() as Served[]).map((p) => p.password_hash)).toEqual([null, null])
})

test("folder with nobody is empty", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  expect((await request(sock, "GET", folder("/w/none"))).json()).toEqual([])
})

test("people are served without their password hash", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const file = path.join(office.paths.company, "people/ngocbh/person.yaml")
  fs.writeFileSync(file, `${fs.readFileSync(file, "utf8")}password_hash: "$scrypt$ln=15,r=8,p=1$c2FsdA$aGFzaA"\n`)
  const r = await request(sock, "GET", "/people")
  expect(r.status).toBe(200)
  expect(r.text).not.toContain("scrypt")
  expect((r.json() as Served[]).find((p) => p.handle === "ngocbh")?.password_hash).toBeNull()
})

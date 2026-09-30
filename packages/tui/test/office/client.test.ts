import { afterEach, expect, test } from "bun:test"
import { OFFICE_501_ROUTES, createFakeOffice, type FakeOffice } from "../../script/stub"
import { createOfficeClient } from "../../src/office/client"
import { OfficeError, OfficeTimeout, VersionConflictError, isNotImplemented } from "../../src/office/errors"
import { request } from "../../src/office/http"
import { until } from "../fixture/until"

let office: FakeOffice
afterEach(() => office?.stop())
const client = () => createOfficeClient({ socket: office.socket })
/** The error `p` rejects with; fails the test if it resolves. */
const failure = (p: Promise<unknown>): Promise<any> =>
  p.then(
    () => {
      throw new Error("expected the request to fail")
    },
    (e) => e,
  )

test("people and folder people; the cwd is one encoded segment", async () => {
  office = createFakeOffice()
  expect((await client().people.list()).map((p) => p.handle)).toEqual(["minh", "ngocbh"])
  expect((await client().people.inFolder("/tmp/proj")).map((p) => p.handle)).toEqual(["minh"])
  expect(office.requests.at(-1)?.raw).toBe("/folders/%2Ftmp%2Fproj/people")
})

test("create a session, prompt it, list it by person", async () => {
  office = createFakeOffice()
  const prompts: string[] = []
  office.onPrompt((_, req) => prompts.push(req.text))
  const s = await client().sessions.create({ person: "minh", cwd: "/tmp/proj" })
  expect([s.person, s.kind, s.status]).toEqual(["minh", "main", "idle"])
  expect(await client().sessions.prompt(s.id, { text: "hi" })).toEqual({ ok: true })
  expect(prompts).toEqual(["hi"])
  expect((await client().sessions.messages(s.id)).map((m) => m.role)).toEqual(["user"])
  expect((await client().sessions.get(s.id)).status).toBe("busy")
  expect((await client().sessions.list({ person: "minh", limit: 1 }))[0].id).toBe(s.id)
})

test("interrupt, end, and the cost cap", async () => {
  office = createFakeOffice()
  const id = office.state.sessions[0].id
  await client().sessions.prompt(id, { text: "go" })
  await client().sessions.interrupt(id)
  // The session stays busy until the stopped reply's next turn opens.
  expect((await client().sessions.get(id)).status).toBe("busy")
  expect((await client().sessions.costCap(id, { cost_cap_usd: 5 })).cost_cap_usd).toBe(5)
  // A cap at or below the cost so far is the office's cap_too_low; a cap that isn't a number is invalid_body.
  expect((await failure(client().sessions.costCap(id, { cost_cap_usd: 0 }))).code).toBe("cap_too_low")
  const notNumber = request(office.socket, "POST", `/sessions/${id}/cost-cap`, { cost_cap_usd: "5" })
  expect((await failure(notNumber)).code).toBe("invalid_body")
  await client().sessions.end(id)
  // A main session is debriefed before it ends.
  expect((await client().sessions.get(id)).status).toBe("ending")
  await until(() => office.state.sessions[0].status === "debriefing")
})

test("the first answer wins; the second gets 409 not_open", async () => {
  office = createFakeOffice()
  const q = office.addQuestion({ options: ["yes", "no"] })
  expect((await client().questions.answer(q.id, { answer: "yes", answer_kind: "option" })).status).toBe("answered")
  const err = await failure(client().questions.answer(q.id, { answer: "no", answer_kind: "option" }))
  expect(err).toBeInstanceOf(OfficeError)
  expect([err.status, err.code]).toEqual([409, "not_open"])
})

test("open questions are listed by session and status", async () => {
  office = createFakeOffice()
  const id = office.state.sessions[0].id
  // The seeded session's open turn is listed first.
  const [turn] = Object.keys(office.state.questions)
  const a = office.addQuestion({})
  const b = office.addQuestion({})
  office.addQuestion({ session_id: "OTHER" })
  await client().questions.answer(b.id, { answer: "x", answer_kind: "text" })
  expect((await client().questions.list({ session: id, status: "open" })).map((q) => q.id)).toEqual([turn, a.id])
  expect((await client().questions.list({ session: id, status: ["open", "answered"] })).map((q) => q.id)).toEqual([
    turn,
    a.id,
    b.id,
  ])
  expect(office.requests.at(-1)?.raw).toBe(`/questions?session=${id}&status=open%2Canswered`)
})

test("a stale profile write is a VersionConflictError", async () => {
  office = createFakeOffice()
  const p = await client().profiles.get("minh")
  await client().profiles.put("minh", { text: "v2", base_version: p.version })
  const err = await failure(client().profiles.put("minh", { text: "v3", base_version: p.version }))
  expect(err).toBeInstanceOf(VersionConflictError)
})

test("hire previews, then confirms with the preview's id", async () => {
  office = createFakeOffice()
  const req = { name: "Lan", handle: "lan", title: "QA", manager: "ngocbh" }
  const preview = await client().people.hire({ ...req, confirm: false })
  expect([preview.commit, preview.diff.includes("lan")]).toEqual([null, true])
  const done = await client().people.hire({ ...req, id: preview.person.id, confirm: true })
  expect(done.commit).not.toBeNull()
  expect((await client().people.list()).map((p) => p.handle)).toContain("lan")
})

test("a hire confirm repeats the preview; a taken handle is a lint issue on preview and a 422 on confirm", async () => {
  office = createFakeOffice()
  const req = { name: "Lan", handle: "lan", title: "QA", manager: "ngocbh" }
  const preview = await client().people.hire({ ...req, confirm: false })
  const changed = await failure(client().people.hire({ ...req, title: "Lead", id: preview.person.id, confirm: true }))
  expect([changed.status, changed.code]).toEqual([422, "lint_failed"])
  const dup = await client().people.hire({ ...req, handle: "minh", confirm: false })
  expect(dup.issues).toEqual([
    {
      path: `people/${dup.person.id}/person.yaml`,
      code: "person.duplicate_handle",
      message: "@minh is already used by minh",
      severity: "error",
    },
  ])
  const refused = await failure(client().people.hire({ ...req, handle: "minh", id: dup.person.id, confirm: true }))
  expect([refused.status, refused.code, refused.message]).toEqual([422, "lint_failed", "@minh is already used by minh"])
})

test("a hire confirm with no id is invalid_body; with an id never previewed it is lint_failed", async () => {
  office = createFakeOffice()
  const req = { name: "Lan", handle: "lan", title: "QA", manager: "ngocbh" }
  expect((await failure(client().people.hire({ ...req, confirm: true }))).code).toBe("invalid_body")
  const unseen = await failure(client().people.hire({ ...req, id: "01JA1H0000000000000000NEW0", confirm: true }))
  expect([unseen.status, unseen.code]).toEqual([422, "lint_failed"])
  expect(unseen.message).toContain("preview it again")
})

test("a hire checks the body like the office; an unknown manager is a lint issue", async () => {
  office = createFakeOffice()
  const req = { name: "Lan", handle: "lan", title: "QA", manager: "ngocbh" }
  for (const body of [
    { ...req, handle: "Lan" },
    { ...req, extra: 1 },
    { ...req, id: "minh" },
  ]) {
    const e = await failure(client().people.hire(body as any))
    expect([e.status, e.code]).toEqual([422, "invalid_body"])
  }
  const orphan = await client().people.hire({ ...req, manager: "kai", confirm: false })
  expect(orphan.issues).toEqual([
    { path: `people/${orphan.person.id}/person.yaml`, code: "person.unknown_manager", message: "kai", severity: "error" },
  ])
  const refused = await failure(client().people.hire({ ...req, manager: "kai", id: orphan.person.id, confirm: true }))
  expect([refused.status, refused.code, refused.message]).toEqual([422, "lint_failed", "kai"])
})

test("routes switched off answer 501 like today's office", async () => {
  office = createFakeOffice({ notImplemented: OFFICE_501_ROUTES })
  const err = await failure(client().sessions.create({ person: "minh", cwd: "/tmp/proj" }))
  expect(isNotImplemented(err)).toBe(true)
  expect(err.message).toBe("POST /sessions is not implemented yet")
})

test("unknown paths and wrong methods", async () => {
  office = createFakeOffice()
  expect((await failure(request(office.socket, "GET", "/nope"))).code).toBe("no_route")
  expect((await failure(request(office.socket, "PUT", "/people", {}))).status).toBe(405)
  expect((await failure(client().sessions.get("NOPE"))).code).toBe("not_found")
  expect((await failure(request(office.socket, "POST", "/sessions", { person: 1 }))).code).toBe("invalid_body")
})

test("reads give up after timeoutMs with an OfficeTimeout", async () => {
  office = createFakeOffice()
  const release = office.hold("GET /sessions/:id/messages")
  const c = createOfficeClient({ socket: office.socket, timeoutMs: 50 })
  const err = await failure(c.sessions.messages(office.state.sessions[0].id))
  release()
  expect(err).toBeInstanceOf(OfficeTimeout)
  expect(err.message).toContain("/messages")
})

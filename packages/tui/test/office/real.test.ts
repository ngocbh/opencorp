// The client against a real office on a temp home: one office for the file, each test in its own folder and with
// its own handles, so no test depends on another's order. Tests that need the fake's knobs are in client.test.ts.
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { CREATE_TIMEOUT_MS, createOfficeClient, request, VersionConflictError } from "@opencorp/client"
import { startOffice, type TestOffice } from "@opencorp/office/testing/office"
import fs from "node:fs"
import path from "node:path"
import { until } from "../fixture/until"

let office: TestOffice
beforeAll(async () => {
  office = await startOffice()
}, 60_000)
afterAll(() => office?.stop())

const client = () => createOfficeClient({ socket: office.socket })
/** The error `p` rejects with; fails the test if it resolves. */
const failure = (p: Promise<unknown>): Promise<any> =>
  p.then(
    () => {
      throw new Error("expected the request to fail")
    },
    (e) => e,
  )
/** A new folder `name` under the office's temp root, as its real path. */
const folder = (name: string) => {
  const dir = path.join(office.root, name)
  fs.mkdirSync(dir)
  return fs.realpathSync(dir)
}
/** Waits until session `id` is `status`; fails after 20 s. */
const reach = (id: string, status: string) =>
  until(async () => (await client().sessions.get(id)).status === status, 20_000)
/** A chat of minh's in a new folder `name`, once it is idle. */
async function chat(name: string) {
  const s = await client().sessions.create({ person: "minh", cwd: folder(name) })
  await reach(s.id, "idle")
  return s
}

test("people and folder people; the cwd is one encoded segment", async () => {
  expect((await client().people.list()).map((p) => p.handle)).toEqual(expect.arrayContaining(["minh", "ngocbh"]))
  const cwd = folder("people")
  expect(await client().people.inFolder(cwd)).toEqual([])
  await client().sessions.create({ person: "minh", cwd })
  expect((await client().people.inFolder(cwd)).map((p) => p.handle)).toEqual(["minh"])
})

test("create a session, prompt it, list it by person", async () => {
  office.llm.script({ content: "Hello from minh." })
  const s = await client().sessions.create({ person: "minh", cwd: folder("prompt") })
  expect([s.person, s.kind, s.status]).toEqual(["minh", "main", "starting"])
  // A prompt sent while the session starts is queued until it is ready.
  expect(await client().sessions.prompt(s.id, { text: "hi" })).toEqual({ ok: true })
  await until(async () => (await client().sessions.messages(s.id)).length === 2, 20_000)
  await reach(s.id, "idle")
  const messages = await client().sessions.messages(s.id)
  expect(messages.map((m) => [m.role, m.parts.map((p) => (p.type === "text" ? p.text : p.type))])).toEqual([
    ["user", ["hi"]],
    ["assistant", ["Hello from minh."]],
  ])
  expect((await client().sessions.list({ person: "minh", limit: 1 }))[0].id).toBe(s.id)
})

test("interrupt, end, and the cost cap", async () => {
  const { id } = await chat("interrupt")
  office.llm.script({ content: "never sent", hold: true })
  await client().sessions.prompt(id, { text: "go" })
  await reach(id, "busy")
  await client().sessions.interrupt(id)
  office.llm.release()
  await reach(id, "idle")
  expect((await client().sessions.costCap(id, { cost_cap_usd: 5 })).cost_cap_usd).toBe(5)
  // A cap at or below the cost so far is the office's cap_too_low; a cap that isn't a number is invalid_body.
  expect((await failure(client().sessions.costCap(id, { cost_cap_usd: 0 }))).code).toBe("cap_too_low")
  const notNumber = request(office.socket, "POST", `/sessions/${id}/cost-cap`, { cost_cap_usd: "5" })
  expect((await failure(notNumber)).code).toBe("invalid_body")
  await client().sessions.end(id)
  expect((await client().sessions.get(id)).status).toBe("ending")
  await reach(id, "ended")
})

test("a stale profile write is a VersionConflictError", async () => {
  const p = await client().profiles.get("minh")
  await client().profiles.put("minh", { text: "v2", base_version: p.version })
  const err = await failure(client().profiles.put("minh", { text: "v3", base_version: p.version }))
  expect(err).toBeInstanceOf(VersionConflictError)
})

test("hire previews, then confirms by handle with no id", async () => {
  const req = { name: "Lan", handle: "lan", title: "QA", manager: "ngocbh" }
  const preview = await client().people.hire({ ...req, confirm: false })
  expect([preview.commit, preview.diff.includes("people/lan/person.yaml"), "id" in preview.person]).toEqual([
    null,
    true,
    false,
  ])
  const done = await client().people.hire({ ...req, confirm: true })
  expect(done.commit).not.toBeNull()
  expect((await client().people.list()).map((p) => p.handle)).toContain("lan")
})

test("a hire confirm repeats the preview; a taken handle is a lint issue on preview and a 422 on confirm", async () => {
  const req = { name: "Mai", handle: "mai", title: "QA", manager: "ngocbh" }
  await client().people.hire({ ...req, confirm: false })
  const changed = await failure(client().people.hire({ ...req, title: "Lead", confirm: true }))
  expect([changed.status, changed.code]).toEqual([422, "lint_failed"])
  const dup = await client().people.hire({ ...req, handle: "minh", confirm: false })
  expect(dup.issues).toEqual([
    { path: "people/minh/person.yaml", code: "person.duplicate_handle", message: "@minh is already taken", severity: "error" },
  ])
  const refused = await failure(client().people.hire({ ...req, handle: "minh", confirm: true }))
  expect([refused.status, refused.code, refused.message]).toEqual([422, "lint_failed", "@minh is already taken"])
})

test("a hire confirm never previewed is lint_failed", async () => {
  const req = { name: "Tuan", handle: "tuan", title: "QA", manager: "ngocbh" }
  const unseen = await failure(client().people.hire({ ...req, confirm: true }))
  expect([unseen.status, unseen.code]).toEqual([422, "lint_failed"])
  expect(unseen.message).toContain("preview it again")
})

test("a hire checks the body like the office; an unknown manager is a lint issue", async () => {
  const req = { name: "Hoa", handle: "hoa", title: "QA", manager: "ngocbh" }
  for (const body of [
    { ...req, handle: "Hoa" },
    { ...req, extra: 1 },
    { ...req, id: "minh" },
  ]) {
    const e = await failure(client().people.hire(body as any))
    expect([e.status, e.code]).toEqual([422, "invalid_body"])
  }
  const orphan = await client().people.hire({ ...req, manager: "kai", confirm: false })
  expect(orphan.issues).toEqual([
    { path: "people/hoa/person.yaml", code: "person.unknown_manager", message: "kai", severity: "error" },
  ])
  const refused = await failure(client().people.hire({ ...req, manager: "kai", confirm: true }))
  expect([refused.status, refused.code, refused.message]).toEqual([422, "lint_failed", "kai"])
})

test("unknown paths and wrong methods", async () => {
  expect((await failure(request(office.socket, "GET", "/nope"))).code).toBe("no_route")
  expect((await failure(request(office.socket, "PUT", "/people", {}))).status).toBe(405)
  expect((await failure(client().sessions.get("NOPE"))).code).toBe("not_found")
  expect((await failure(request(office.socket, "POST", "/sessions", { person: 1 }))).code).toBe("invalid_body")
})

test("connections: the list with can_manage for the asker, a connection's models, and ?refresh=1", async () => {
  const list = await client().connections.list()
  expect(list.connections.map((c) => `${c.name} (${c.provider})`)).toEqual(["office (vllm)"])
  expect([list.default, list.can_manage]).toEqual(["office", true])
  const models = await client().connections.models("office")
  expect([models.connection, models.listed, models.models.map((m) => m.id)]).toEqual(["office", true, ["stub"]])
  expect((await client().connections.models("office", { refresh: true })).models.map((m) => m.id)).toEqual(["stub"])
  expect((await failure(client().connections.models("nope"))).code).toBe("not_found")
})

test("continue waits the create limit; the office refuses a composer session", async () => {
  const { id } = await chat("continue")
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  const asked: number[] = []
  const spy = spyOn(AbortSignal, "timeout").mockImplementation((ms) => (asked.push(ms), timeout(ms)))
  const refused = await failure(client().sessions.continue(id)).finally(() => spy.mockRestore())
  expect(asked).toEqual([CREATE_TIMEOUT_MS])
  expect([refused.status, refused.code]).toEqual([422, "not_continuable"])
})

/** Profile routes over `office.profileStore` (a git-blob-versioned file store here), and the profile manager's. */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import type { Message } from "@opencorp/protocol"
import { parse as parseYaml, stringify } from "yaml"
import { newToken } from "../../src/auth/tokens.ts"
import type { Office } from "../../src/daemon/office.ts"
import { MANAGER_FLOW, propose } from "../../src/profile/manager.ts"
import { blobId, GitProfileStore } from "../../src/profile/store.ts"
import type { ProfileProposalRecord } from "../../src/store/store.ts"
import type { FakeLLM } from "../../src/testing/fake_llm.ts"
import { fakeLlm, makeHarness, ROOT, status } from "../chat/helpers.ts"
import { git, stashPopConflict } from "../company/helpers.ts"
import { waitFor } from "../helpers.ts"
import { proposal, recordEvents, session } from "../store/helpers.ts"
import {
  addHuman,
  bearer,
  blobStores,
  giveDevice,
  makeOffice,
  request,
  served,
  standInHarness,
  ULID,
} from "./helpers.ts"

setDefaultTimeout(30_000)

const MINH = "# Minh, Engineer\n"

type Reply = Awaited<ReturnType<typeof request>>

const blob = (text: string) => blobId(Buffer.from(text))
const errorOf = (reply: Reply) => (reply.json() as { error: string }).error

function put(sock: string, body: unknown): Promise<Reply> {
  return request(sock, "PUT", "/profiles/minh", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/** A proposal of `text` over minh's current profile, from a new profile-manager session. */
async function proposeText(office: Office, text: string): Promise<ProfileProposalRecord> {
  const s = office.store.createSession(session({ kind: "profile_manager" }))
  const profile = new GitProfileStore(office.git, "minh")
  const [base, version] = await profile.read()
  return propose(office.store, s, profile, version, base, text)
}

/** Sets `defaults.profile_max_chars` in the working tree's company.yaml. */
function setMaxChars(company: string, chars: number): void {
  const file = path.join(company, "company.yaml")
  const data = parseYaml(fs.readFileSync(file, "utf8")) as { defaults: Record<string, unknown> }
  data.defaults.profile_max_chars = chars
  fs.writeFileSync(file, stringify(data))
}

test("get profile", async () => {
  const office = makeOffice()
  blobStores(office)
  const { sock } = await served(office)
  const r = await request(sock, "GET", "/profiles/minh")
  expect(r.status).toBe(200)
  expect(r.json()).toEqual({ person: "minh", text: MINH, version: blob(MINH), over_budget: false })
})

test("over budget uses company defaults", async () => {
  const office = makeOffice()
  blobStores(office)
  const { sock } = await served(office)
  setMaxChars(office.paths.company, 5)
  expect((await request(sock, "GET", "/profiles/minh")).json()).toMatchObject({ over_budget: true })
})

test("over budget counts code points", async () => {
  const office = makeOffice()
  blobStores(office)
  const { sock } = await served(office)
  setMaxChars(office.paths.company, 5)
  // Three code points, six UTF-16 units: within a budget of five, as Python's len counts.
  const r = await put(sock, { text: "😀😀😀", base_version: blob(MINH) })
  expect(r.status).toBe(200)
  expect(r.json()).toMatchObject({ over_budget: false })
})

test("unknown person is 404", async () => {
  const office = makeOffice()
  blobStores(office)
  const { sock } = await served(office)
  for (const r of [
    await request(sock, "GET", "/profiles/ghost"),
    await request(sock, "PUT", "/profiles/ghost", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x", base_version: "a".repeat(40) }),
    }),
  ]) {
    expect(r.status).toBe(404)
    expect(errorOf(r)).toBe("not_found")
  }
})

test("put writes emits and returns the profile", async () => {
  const office = makeOffice()
  const stores = blobStores(office)
  const { sock } = await served(office)
  const events = recordEvents(office.store)
  const r = await put(sock, { text: "# Minh\nterse\n", base_version: blob(MINH) })
  expect(r.status).toBe(200)
  const body = r.json() as { text: string; version: string }
  expect(body.text).toBe("# Minh\nterse\n")
  expect(body.version).toBe(blob("# Minh\nterse\n"))
  expect(fs.readFileSync(path.join(office.paths.company, "people/minh/profile.md"), "utf8")).toBe("# Minh\nterse\n")
  expect(stores.get("minh")!.provenance).toEqual([{ source: "hand edit" }])
  const event = events.at(-1)!
  expect([event.type, event.subject_id, event.data]).toEqual(["profile.updated", "minh", body])
})

test("put with stale base is 409 with both versions", async () => {
  const office = makeOffice()
  blobStores(office)
  const { sock } = await served(office)
  const stale = blob("old\n")
  const r = await put(sock, { text: "x", base_version: stale })
  expect(r.status).toBe(409)
  expect(r.headers["content-type"]).toStartWith("application/json")
  expect(r.json()).toEqual({ expected: stale, current: blob(MINH) })
  expect(fs.readFileSync(path.join(office.paths.company, "people/minh/profile.md"), "utf8")).toBe(MINH)
})

test("put with bad version is 422", async () => {
  const office = makeOffice()
  blobStores(office)
  const { sock } = await served(office)
  const r = await put(sock, { text: "x", base_version: "sha256:abc" })
  expect(r.status).toBe(422)
  expect(errorOf(r)).toBe("invalid_body")
  expect(r.text).not.toContain("sha256:abc")
})

test("no profile store is 501", async () => {
  const office = makeOffice()
  blobStores(office)
  const { sock } = await served(office)
  office.profileStore = null
  expect((await request(sock, "GET", "/profiles/minh")).status).toBe(501)
})

test("put checks the person and store before the body", async () => {
  const office = makeOffice()
  blobStores(office)
  const { sock } = await served(office)
  let r = await request(sock, "PUT", "/profiles/ghost", { body: "not json" })
  expect(r.status).toBe(404)
  expect(errorOf(r)).toBe("not_found")
  office.profileStore = null
  r = await request(sock, "PUT", "/profiles/minh", { body: "not json" })
  expect(r.status).toBe(501)
  expect(errorOf(r)).toBe("not_implemented")
})

test("the office profile store defaults to the git store", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const r = await put(sock, { text: "# Minh\nterse\n", base_version: blob(MINH) })
  expect(r.status).toBe(200)
  expect(git(office.paths.company, "log", "-1", "--format=%s")).toBe("profile(@minh): hand edit")
  expect((await request(sock, "GET", "/profiles/minh")).json()).toMatchObject({ version: blob("# Minh\nterse\n") })
})

test("put on a profile with an unresolved conflict is 409 company_repo_busy and keeps the conflict", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const company = office.paths.company
  const rel = "people/minh/profile.md"
  stashPopConflict(company, rel)
  const conflicted = fs.readFileSync(path.join(company, rel))
  const got = await request(sock, "GET", "/profiles/minh")
  expect(got.status).toBe(200)
  expect(got.json()).toMatchObject({ text: "committed\n", version: blob("committed\n") })
  const r = await put(sock, { text: "# Minh\nterse\n", base_version: blob("committed\n") })
  expect(r.status).toBe(409)
  expect(r.json()).toEqual({
    error: "company_repo_busy",
    message: `${JSON.stringify(rel)} has an unresolved merge conflict in the company repo; resolve it and commit`,
  })
  expect(git(company, "ls-files", "-u")).toContain(rel)
  expect(fs.readFileSync(path.join(company, rel))).toEqual(conflicted)
})

test("proposals are listed oldest first and 404 for no person", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const sid = office.store.createSession(session({ kind: "profile_manager" })).id
  const newer = office.store.addProfileProposal(proposal(sid, { created_at: "2026-10-02T00:00:00.000Z" }))
  const older = office.store.addProfileProposal(proposal(sid, { created_at: "2026-10-01T00:00:00.000Z" }))
  const r = await request(sock, "GET", "/profiles/minh/proposals")
  expect(r.status).toBe(200)
  expect(r.json()).toEqual([older, newer])
  expect((await request(sock, "GET", "/profiles/ngocbh/proposals")).json()).toEqual([])
  const ghost = await request(sock, "GET", "/profiles/ghost/proposals")
  expect([ghost.status, errorOf(ghost)]).toEqual([404, "not_found"])
})

test("a person whose file doesnt load is named as such", async () => {
  const office = makeOffice()
  blobStores(office)
  const { sock } = await served(office)
  fs.writeFileSync(path.join(office.paths.company, "people/minh/person.yaml"), "handle: [SECRETVALUE\n")
  for (const target of ["/profiles/minh", "/profiles/minh/proposals"]) {
    const r = await request(sock, "GET", target)
    expect([r.status, r.json()]).toEqual([404, { error: "not_found", message: "@minh's person.yaml doesn't load; run `opencorp doctor`" }])
    expect(r.text).not.toContain("SECRETVALUE")
  }
  const ghost = await request(sock, "GET", "/profiles/ghost/proposals")
  expect(ghost.json()).toEqual({ error: "not_found", message: "no person ghost" })
})

test("apply is credited to the verified person", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  addHuman(office.paths.company, "ava")
  const token = newToken()
  giveDevice(office.paths.company, "ava", "pc", token)
  const p = await proposeText(office, `${MINH}- One.\n`)
  const events = recordEvents(office.store)
  const r = await request(sock, "POST", `/profile-proposals/${p.id}/apply`, { headers: bearer(token) })
  expect(r.status).toBe(200)
  const text = `${MINH}- One.\n`
  expect(r.json()).toEqual({ person: "minh", text, version: blob(text), over_budget: false })
  expect(git(office.paths.company, "log", "-1", "--format=%s")).toBe("profile(@minh): ava via profile manager")
  expect(office.store.getProfileProposal(p.id)!.status).toBe("applied")
  expect(events.at(-1)!.type).toBe("profile.updated")
  expect((await request(sock, "POST", `/profile-proposals/${p.id}/apply`)).status).toBe(401)
})

test("a second apply is 409 not open", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const p = await proposeText(office, "# Minh\n")
  expect((await request(sock, "POST", `/profile-proposals/${p.id}/apply`)).status).toBe(200)
  const again = await request(sock, "POST", `/profile-proposals/${p.id}/apply`)
  expect([again.status, errorOf(again)]).toEqual([409, "not_open"])
})

test("apply after a hand edit is 409 with both versions", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const p = await proposeText(office, "# Minh\n")
  const file = path.join(office.paths.company, "people/minh/profile.md")
  fs.writeFileSync(file, "# Minh, Staff Engineer\n")
  const r = await request(sock, "POST", `/profile-proposals/${p.id}/apply`)
  expect(r.status).toBe(409)
  expect(r.headers["content-type"]).toStartWith("application/json")
  expect(r.json()).toEqual({ expected: blob(MINH), current: blob("# Minh, Staff Engineer\n") })
  expect(office.store.getProfileProposal(p.id)!.status).toBe("stale")
  expect(fs.readFileSync(file, "utf8")).toBe("# Minh, Staff Engineer\n")
})

test("apply of an unknown proposal is 404", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const r = await request(sock, "POST", `/profile-proposals/${ULID}/apply`)
  expect([r.status, errorOf(r)]).toEqual([404, "not_found"])
})

// The profile manager's chat over the routes (Python's `tests/daemon/test_routes_learning.py`), on a chat harness
// over the fake LLM.

/** A chat harness over `fake` whose company has the template's profile manager flow. */
function managerHarness(fake: FakeLLM) {
  return makeHarness(fake, { files: { [MANAGER_FLOW]: fs.readFileSync(path.join(ROOT, MANAGER_FLOW), "utf8") } })
}

/** POSTs `body` as JSON with `headers`. */
function postJson(sock: string, target: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return request(sock, "POST", target, {
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

test("learning routes need learning [POST /profiles/minh/manager]", async () => {
  // A harness that runs no profile manager, as Codex sessions don't.
  const office = makeOffice()
  office.harness = standInHarness()
  const { sock } = await served(office)
  const r = await postJson(sock, "/profiles/minh/manager", { text: "tidy" })
  expect([r.status, errorOf(r)]).toEqual([501, "not_implemented"])
  office.harness = undefined
  expect(errorOf(await postJson(sock, "/profiles/minh/manager", { text: "tidy" }))).toBe("not_implemented")
})

test("learning routes need learning before a body [POST /profiles/minh/manager]", async () => {
  const { sock } = await served(makeOffice())
  for (const body of [JSON.stringify({ bad: true }), "not json"]) {
    const r = await request(sock, "POST", "/profiles/minh/manager", {
      headers: { "content-type": "application/json" },
      body,
    })
    expect([r.status, errorOf(r)]).toEqual([501, "not_implemented"])
  }
})

test("the profile manager over the routes", async () => {
  const fake = await fakeLlm()
  const h = await managerHarness(fake)
  const { store, git: g } = h.office
  const { sock } = await served(h.office)
  fake.script({ content: "What should change?" })
  let r = await postJson(sock, "/profiles/minh/manager", { text: "Tidy my profile." })
  expect(r.status).toBe(200)
  const created = r.json() as { id: string; kind: string; person: string }
  expect([created.kind, created.person]).toEqual(["profile_manager", "minh"])
  const manager = store.getSession(created.id)!
  const profile = new GitProfileStore(g, "minh")
  let [text, version] = await profile.read()
  const first = await propose(store, manager, profile, version, text, `${MINH}\n- One.\n`)
  r = await request(sock, "GET", "/profiles/minh/proposals")
  expect((r.json() as { id: string }[]).map((p) => p.id)).toEqual([first.id])

  r = await request(sock, "POST", `/profile-proposals/${first.id}/apply`)
  expect(r.status).toBe(200)
  expect((r.json() as { text: string }).text).toBe(`${MINH}\n- One.\n`)
  r = await request(sock, "POST", `/profile-proposals/${first.id}/apply`)
  expect([r.status, errorOf(r)]).toEqual([409, "not_open"])

  ;[text, version] = await profile.read()
  const second = await propose(store, manager, profile, version, text, `${text}- Two.\n`)
  fs.writeFileSync(path.join(g.root, "people/minh/profile.md"), `${MINH}\n- Hand edit.\n`)
  r = await request(sock, "POST", `/profile-proposals/${second.id}/apply`)
  expect(r.status).toBe(409)
  expect(r.json()).toEqual({ expected: version, current: (await profile.read())[1] })
  expect(store.getProfileProposal(second.id)!.status).toBe("stale")
})

test("a manager chat takes a later turn over the session routes", async () => {
  const fake = await fakeLlm()
  const h = await managerHarness(fake)
  const { sock } = await served(h.office)
  fake.script({ content: "What should change?" }, { content: "Noted." })
  const sid = (
    (await postJson(sock, "/profiles/minh/manager", { text: "Tidy my profile." })).json() as { id: string }
  ).id
  /** The text parts of the session's messages over the messages route, and their roles. */
  const read = async () => {
    const messages = (await request(sock, "GET", `/sessions/${sid}/messages`)).json() as Message[]
    const texts = messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])))
    return { roles: messages.map((m) => m.role), texts }
  }
  await waitFor(async () => status(h, sid) === "idle" && (await read()).roles.join() === "user,assistant", {
    what: "the first reply",
  })
  const r = await postJson(sock, `/sessions/${sid}/prompt`, { text: "Drop the old team." })
  expect(r.json()).toEqual({ ok: true })
  // The reply's message exists from the turn's start, before its text lands.
  const all = ["Tidy my profile.", "What should change?", "Drop the old team.", "Noted."]
  await waitFor(async () => (await read()).texts.join("|") === all.join("|"), { what: "the second reply" })
  expect(JSON.stringify(fake.requests().at(-1)!.messages)).toContain("Drop the old team.")
})

test("learning routes refuse bad requests", async () => {
  const h = await managerHarness(await fakeLlm())
  const { sock } = await served(h.office)
  const cases: [string, string, unknown, number, string][] = [
    ["POST", "/profiles/nobody/manager", { text: "hi" }, 404, "not_found"],
    ["POST", "/profiles/minh/manager", { text: "" }, 422, "invalid_body"],
    ["GET", "/profiles/nobody/proposals", null, 404, "not_found"],
    ["POST", `/profile-proposals/${ULID}/apply`, null, 404, "not_found"],
  ]
  for (const [method, target, body, status, code] of cases) {
    const r = body === null ? await request(sock, method, target) : await postJson(sock, target, body)
    expect([target, r.status, errorOf(r)]).toEqual([target, status, code])
  }
  expect(h.store.listSessions({ kind: "profile_manager" })).toEqual([])
})

test("learning is credited to the verified person", async () => {
  const fake = await fakeLlm()
  const h = await managerHarness(fake)
  const { store, git: g, paths } = h.office
  const { sock } = await served(h.office, { tokens: true })
  addHuman(paths.company, "ava")
  const token = newToken()
  giveDevice(paths.company, "ava", "pc", token)
  fake.script({ content: "What should change?" })
  const r = await postJson(sock, "/profiles/minh/manager", { text: "Tidy my profile." }, bearer(token))
  expect(r.status).toBe(200)
  expect((r.json() as { opened_by: string }).opened_by).toBe("ava")
  const manager = store.getSession((r.json() as { id: string }).id)!
  const profile = new GitProfileStore(g, "minh")
  const [text, version] = await profile.read()
  const p = await propose(store, manager, profile, version, text, `${text}- One.\n`)
  const applied = await request(sock, "POST", `/profile-proposals/${p.id}/apply`, { headers: bearer(token) })
  expect(applied.status).toBe(200)
  expect(git(paths.company, "log", "-1", "--format=%s")).toBe("profile(@minh): ava via profile manager")
})

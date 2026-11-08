/** Profile routes over `office.profileStore`, the office's FileMemory on a person's memory folder, and the profile
 *  manager's. */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import type { Message } from "@opencorp/protocol"
import { parse as parseYaml, stringify } from "yaml"
import { newToken } from "../../src/auth/tokens.ts"
import type { Office } from "../../src/daemon/office.ts"
import { MANAGER_FLOW, propose } from "../../src/profile/manager.ts"
import { GitProfileStore, profileHash } from "../../src/profile/store.ts"
import type { ProfileProposalRecord } from "../../src/store/store.ts"
import type { FakeLLM } from "../../src/testing/fake_llm.ts"
import { fakeLlm, makeHarness, ROOT, status } from "../chat/helpers.ts"
import { git, stashPopConflict } from "../company/helpers.ts"
import { waitFor } from "../helpers.ts"
import { proposal, recordEvents, session } from "../store/helpers.ts"
import {
  addHuman,
  bearer,
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

const hash = (text: string) => profileHash(Buffer.from(text))
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
  const profile = new GitProfileStore(office.git, "minh", { maxChars: 32000 })
  const { text: base, version } = await profile.read()
  return propose(office.store, s, profile, version, base, text)
}

/** Makes `manager` the manager of `handle` in the repo at `company`, committed. */
function setManager(company: string, handle: string, manager: string): void {
  const file = path.join(company, "people", handle, "person.yaml")
  const data = parseYaml(fs.readFileSync(file, "utf8")) as Record<string, unknown>
  data.manager = manager
  fs.writeFileSync(file, stringify(data))
  git(company, "commit", "-qam", `${handle} reports to ${manager}`)
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
  const { sock } = await served(office)
  const r = await request(sock, "GET", "/profiles/minh")
  expect(r.status).toBe(200)
  expect(r.json()).toEqual({ person: "minh", text: MINH, version: hash(MINH), over_budget: false })
})

test("over budget uses company defaults", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  setMaxChars(office.paths.company, 5)
  expect((await request(sock, "GET", "/profiles/minh")).json()).toMatchObject({ over_budget: true })
})

test("over budget counts code points", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  setMaxChars(office.paths.company, 5)
  // Three code points, six UTF-16 units: within a budget of five, as Python's len counts.
  const r = await put(sock, { text: "😀😀😀", base_version: hash(MINH) })
  expect(r.status).toBe(200)
  expect(r.json()).toMatchObject({ over_budget: false })
})

test("unknown person is 404", async () => {
  const office = makeOffice()
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
  const { sock } = await served(office)
  const events = recordEvents(office.store)
  const r = await put(sock, { text: "# Minh\nterse\n", base_version: hash(MINH) })
  expect(r.status).toBe(200)
  const body = r.json() as { text: string; version: string }
  expect(body.text).toBe("# Minh\nterse\n")
  expect(body.version).toBe(hash("# Minh\nterse\n"))
  expect(fs.readFileSync(path.join(office.paths.company, PROFILE), "utf8")).toBe("# Minh\nterse\n")
  expect(git(office.paths.company, "log", "-1", "--format=%s")).toBe("profile(@minh): ngocbh via profile edit")
  const event = events.at(-1)!
  expect([event.type, event.subject_id, event.data]).toEqual(["profile.updated", "minh", body])
})

test("put with stale base is 409 with both versions", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const stale = hash("old\n")
  const r = await put(sock, { text: "x", base_version: stale })
  expect(r.status).toBe(409)
  expect(r.headers["content-type"]).toStartWith("application/json")
  expect(r.json()).toEqual({ expected: stale, current: hash(MINH) })
  expect(fs.readFileSync(path.join(office.paths.company, "people/minh/memory/profile.md"), "utf8")).toBe(MINH)
})

test("put with bad version is 422", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const r = await put(sock, { text: "x", base_version: "sha256:abc" })
  expect(r.status).toBe(422)
  expect(errorOf(r)).toBe("invalid_body")
  expect(r.text).not.toContain("sha256:abc")
})

test("no profile store is 501", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  office.profileStore = null
  expect((await request(sock, "GET", "/profiles/minh")).status).toBe(501)
})

test("put checks the person and store before the body", async () => {
  const office = makeOffice()
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
  const r = await put(sock, { text: "# Minh\nterse\n", base_version: hash(MINH) })
  expect(r.status).toBe(200)
  expect(git(office.paths.company, "log", "-1", "--format=%s")).toBe("profile(@minh): ngocbh via profile edit")
  expect((await request(sock, "GET", "/profiles/minh")).json()).toMatchObject({ version: hash("# Minh\nterse\n") })
})

test("put on a profile with an unresolved conflict is 409 company_repo_busy and keeps the conflict", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const company = office.paths.company
  const rel = "people/minh/memory/profile.md"
  stashPopConflict(company, rel)
  const conflicted = fs.readFileSync(path.join(company, rel))
  // The memory is the working tree, markers and all.
  const got = await request(sock, "GET", "/profiles/minh")
  expect(got.status).toBe(200)
  expect(got.json()).toMatchObject({ text: conflicted.toString(), version: profileHash(conflicted) })
  const r = await put(sock, { text: "# Minh\nterse\n", base_version: profileHash(conflicted) })
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
  setManager(office.paths.company, "minh", "ava")
  const token = newToken()
  giveDevice(office.paths.company, "ava", "pc", token)
  const p = await proposeText(office, `${MINH}- One.\n`)
  const events = recordEvents(office.store)
  const r = await request(sock, "POST", `/profile-proposals/${p.id}/apply`, { headers: bearer(token) })
  expect(r.status).toBe(200)
  const text = `${MINH}- One.\n`
  expect(r.json()).toEqual({ person: "minh", text, version: hash(text), over_budget: false })
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
  const file = path.join(office.paths.company, "people/minh/memory/profile.md")
  fs.writeFileSync(file, "# Minh, Staff Engineer\n")
  const r = await request(sock, "POST", `/profile-proposals/${p.id}/apply`)
  expect(r.status).toBe(409)
  expect(r.headers["content-type"]).toStartWith("application/json")
  expect(r.json()).toEqual({ expected: hash(MINH), current: hash("# Minh, Staff Engineer\n") })
  expect(office.store.getProfileProposal(p.id)!.status).toBe("stale")
  expect(fs.readFileSync(file, "utf8")).toBe("# Minh, Staff Engineer\n")
})

test("apply of an unknown proposal is 404", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const r = await request(sock, "POST", `/profile-proposals/${ULID}/apply`)
  expect([r.status, errorOf(r)]).toEqual([404, "not_found"])
})

test("put with a lone surrogate is 422 and writes nothing", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const head = git(office.paths.company, "rev-parse", "HEAD")
  // Raw, as JSON.stringify would escape it the same way but the test should show what goes on the wire.
  const r = await request(sock, "PUT", "/profiles/minh", {
    headers: { "content-type": "application/json" },
    body: `{"text":"# Minh\\ud800\\n","base_version":"${hash(MINH)}"}`,
  })
  expect(r.status).toBe(422)
  expect(r.json()).toMatchObject({ error: "invalid_body", message: "text: holds a lone surrogate" })
  expect(r.text).not.toContain("ud800")
  expect(r.text).not.toContain("# Minh")
  expect(git(office.paths.company, "rev-parse", "HEAD")).toBe(head)
})

const PROFILE = "people/minh/memory/profile.md"

test("a profile over 4 x profile_max_chars is 409 unreadable_profile on get and put", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  setMaxChars(office.paths.company, 5)
  fs.writeFileSync(path.join(office.paths.company, PROFILE), "x".repeat(21))
  const message =
    "people/minh/memory/profile.md holds 21 characters, more than the 20 a profile may hold " +
    "(4 × profile_max_chars); chats leave it out until it is shortened by hand"
  const got = await request(sock, "GET", "/profiles/minh")
  expect([got.status, got.json()]).toEqual([409, { error: "unreadable_profile", message }])
  const r = await put(sock, { text: "short\n", base_version: hash("x".repeat(21)) })
  expect([r.status, r.json()]).toEqual([409, { error: "unreadable_profile", message }])
})

test("put of text over 4 x profile_max_chars is 422 refused and writes nothing", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  setMaxChars(office.paths.company, 5)
  const r = await put(sock, { text: "x".repeat(21), base_version: hash(MINH) })
  expect([r.status, r.json()]).toEqual([
    422,
    { error: "refused", message: "`profile.md` would hold 21 characters; a file may hold 20" },
  ])
  expect(fs.readFileSync(path.join(office.paths.company, PROFILE), "utf8")).toBe(MINH)
})

test("get of a non UTF-8 profile is 409 unreadable_profile", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  fs.writeFileSync(path.join(office.paths.company, PROFILE), Buffer.from("# M\xffinh\n", "latin1"))
  const r = await request(sock, "GET", "/profiles/minh")
  expect(r.status).toBe(409)
  expect(r.json()).toEqual({ error: "unreadable_profile", message: "people/minh/memory/profile.md is not UTF-8" })
})

test("a symlinked profile is 409 on get and put", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const company = office.paths.company
  const outside = path.join(path.dirname(company), "outside.md")
  fs.writeFileSync(outside, MINH)
  fs.rmSync(path.join(company, PROFILE))
  fs.symlinkSync(outside, path.join(company, PROFILE))
  const got = await request(sock, "GET", "/profiles/minh")
  expect([got.status, errorOf(got)]).toEqual([409, "unreadable_profile"])
  expect(got.text).not.toContain(outside)
  git(company, "add", PROFILE)
  git(company, "commit", "-qm", "link")
  const r = await put(sock, { text: "pwned\n", base_version: git(company, "rev-parse", `HEAD:${PROFILE}`) })
  expect([r.status, errorOf(r)]).toEqual([409, "unreadable_profile"])
  expect(r.text).not.toContain(outside)
  expect(fs.readFileSync(outside, "utf8")).toBe(MINH)
})

/** Replaces minh's profile.md in `company` with a folder holding a file. */
function folderProfile(company: string): void {
  fs.rmSync(path.join(company, PROFILE))
  fs.mkdirSync(path.join(company, PROFILE))
  fs.writeFileSync(path.join(company, PROFILE, "x"), "x\n")
}

test("a folder profile is 409 on get and put", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  folderProfile(office.paths.company)
  const message = "people/minh/memory/profile.md is not a regular file"
  const got = await request(sock, "GET", "/profiles/minh")
  expect([got.status, got.json()]).toEqual([409, { error: "unreadable_profile", message }])
  const r = await put(sock, { text: "x\n", base_version: hash(MINH) })
  expect([r.status, r.json()]).toEqual([409, { error: "unreadable_profile", message }])
})

test("apply onto a folder profile is 409 and the proposal stays open", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const p = await proposeText(office, "# Minh\n")
  folderProfile(office.paths.company)
  const r = await request(sock, "POST", `/profile-proposals/${p.id}/apply`)
  expect([r.status, errorOf(r)]).toEqual([409, "unreadable_profile"])
  expect(office.store.getProfileProposal(p.id)!.status).toBe("open")
})

test.each([
  ["yaml", ["people/minh/person.yaml"]],
  ["folder", ["-r", "people/minh"]],
])("apply after the person's %s is removed is 404", async (_label, args) => {
  const office = makeOffice()
  const { sock } = await served(office)
  const company = office.paths.company
  const p = await proposeText(office, "# Minh\n")
  git(company, "rm", "-q", ...args)
  git(company, "commit", "-qm", "drop minh")
  const head = git(company, "rev-parse", "HEAD")
  const r = await request(sock, "POST", `/profile-proposals/${p.id}/apply`)
  expect([r.status, r.json()]).toEqual([404, { error: "not_found", message: "no person minh" }])
  expect(git(company, "rev-parse", "HEAD")).toBe(head)
  expect(office.store.getProfileProposal(p.id)!.status).toBe("open")
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
  const profile = new GitProfileStore(g, "minh", { maxChars: 32000 })
  let { text, version } = await profile.read()
  const first = await propose(store, manager, profile, version, text, `${MINH}\n- One.\n`)
  r = await request(sock, "GET", "/profiles/minh/proposals")
  expect((r.json() as { id: string }[]).map((p) => p.id)).toEqual([first.id])

  r = await request(sock, "POST", `/profile-proposals/${first.id}/apply`)
  expect(r.status).toBe(200)
  expect((r.json() as { text: string }).text).toBe(`${MINH}\n- One.\n`)
  r = await request(sock, "POST", `/profile-proposals/${first.id}/apply`)
  expect([r.status, errorOf(r)]).toEqual([409, "not_open"])

  ;({ text, version } = await profile.read())
  const second = await propose(store, manager, profile, version, text, `${text}- Two.\n`)
  fs.writeFileSync(path.join(g.root, "people/minh/memory/profile.md"), `${MINH}\n- Hand edit.\n`)
  r = await request(sock, "POST", `/profile-proposals/${second.id}/apply`)
  expect(r.status).toBe(409)
  expect(r.json()).toEqual({ expected: version, current: (await profile.read()).version })
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

test("a blank first message starts no profile manager", async () => {
  const fake = await fakeLlm()
  const h = await managerHarness(fake)
  const { sock } = await served(h.office)
  for (const text of [" \n", "\u0000"]) {
    const r = await postJson(sock, "/profiles/minh/manager", { text })
    expect([r.status, r.json()]).toEqual([422, { error: "invalid_body", message: "text: isn't in the right format" }])
  }
  expect(h.store.listSessions({ kind: "profile_manager" })).toEqual([])
  expect(fake.requests()).toEqual([])
})

test("learning is credited to the verified person", async () => {
  const fake = await fakeLlm()
  const h = await managerHarness(fake)
  const { store, git: g, paths } = h.office
  const { sock } = await served(h.office, { tokens: true })
  addHuman(paths.company, "ava")
  setManager(paths.company, "minh", "ava")
  const token = newToken()
  giveDevice(paths.company, "ava", "pc", token)
  fake.script({ content: "What should change?" })
  const r = await postJson(sock, "/profiles/minh/manager", { text: "Tidy my profile." }, bearer(token))
  expect(r.status).toBe(200)
  expect((r.json() as { opened_by: string }).opened_by).toBe("ava")
  const manager = store.getSession((r.json() as { id: string }).id)!
  const profile = new GitProfileStore(g, "minh", { maxChars: 32000 })
  const { text, version } = await profile.read()
  const p = await propose(store, manager, profile, version, text, `${text}- One.\n`)
  const applied = await request(sock, "POST", `/profile-proposals/${p.id}/apply`, { headers: bearer(token) })
  expect(applied.status).toBe(200)
  expect(git(paths.company, "log", "-1", "--format=%s")).toBe("profile(@minh): ava via profile manager")
})

// Who may change a profile: the CEO, or a human on the person's manager chain.

/** An office checking tokens, with human bob (under the CEO) and devices for bob and the CEO; their tokens. */
async function withBob(office: Office) {
  const { sock } = await served(office, { tokens: true })
  const company = office.paths.company
  addHuman(company, "bob")
  const [ceo, bob] = [newToken(), newToken()]
  giveDevice(company, "ngocbh", "mac", ceo)
  giveDevice(company, "bob", "pc", bob)
  return { sock, company, ceo: bearer(ceo), bob: bearer(bob) }
}

test("profile writes need the CEO or a human manager", async () => {
  const office = makeOffice()
  const { sock, company, bob } = await withBob(office)
  for (const target of ["/profiles/minh", "/profiles/ngocbh", "/profiles/bob"]) {
    const r = await request(sock, "PUT", target, { headers: bob, body: "not json" })
    expect([target, r.status, errorOf(r)]).toEqual([target, 403, "forbidden"])
  }
  const refused = await request(sock, "PUT", "/profiles/minh", { headers: bob, body: "not json" })
  expect((refused.json() as { message: string }).message).toBe(
    "only the CEO or @minh's human managers can change @minh's profile",
  )
  // Reading stays open.
  expect((await request(sock, "GET", "/profiles/minh", { headers: bob })).status).toBe(200)
  expect((await request(sock, "GET", "/profiles/minh/proposals", { headers: bob })).status).toBe(200)

  setManager(company, "minh", "bob")
  const r = await request(sock, "PUT", "/profiles/minh", {
    headers: { ...bob, "content-type": "application/json" },
    body: JSON.stringify({ text: "# Minh\nterse\n", base_version: hash(MINH) }),
  })
  expect(r.status).toBe(200)
  expect(git(company, "log", "-1", "--format=%s")).toBe("profile(@minh): bob via profile edit")
})

test("the manager route checks the person then access before the body", async () => {
  const h = await managerHarness(await fakeLlm())
  const { sock, ceo, bob } = await withBob(h.office)
  const cases: [Record<string, string>, string, number, string][] = [
    [ceo, "/profiles/ghost/manager", 404, "not_found"],
    [bob, "/profiles/ghost/manager", 404, "not_found"],
    [bob, "/profiles/minh/manager", 403, "forbidden"],
  ]
  for (const [headers, target, code, error] of cases) {
    const r = await request(sock, "POST", target, {
      headers: { ...headers, "content-type": "application/json" },
      body: "garbage",
    })
    expect([target, r.status, errorOf(r)]).toEqual([target, code, error])
  }
  expect(h.store.listSessions({ kind: "profile_manager" })).toEqual([])
})

test("apply needs profile access", async () => {
  const office = makeOffice()
  const { sock, company, ceo, bob } = await withBob(office)
  const p = await proposeText(office, `${MINH}- One.\n`)
  const apply = (id: string, headers: Record<string, string>) =>
    request(sock, "POST", `/profile-proposals/${id}/apply`, { headers })
  let r = await apply(p.id, bob)
  expect([r.status, errorOf(r)]).toEqual([403, "forbidden"])
  expect(office.store.getProfileProposal(p.id)!.status).toBe("open")
  r = await apply(ULID, bob)
  expect([r.status, errorOf(r)]).toEqual([404, "not_found"])

  fs.rmSync(path.join(company, "people/minh"), { recursive: true })
  git(company, "add", "-A")
  git(company, "commit", "-qm", "minh leaves")
  r = await apply(p.id, bob)
  expect([r.status, errorOf(r)]).toEqual([403, "forbidden"])
  expect((await apply(p.id, ceo)).status).not.toBe(403)
})

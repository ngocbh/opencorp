/** The profile manager: proposing edits to a profile, applying a proposal, and its chat (Python's
 *  `tests/profile/test_manager.py` and `tests/profile/test_learning_manager.py`). */
import fs from "node:fs"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { MarkdownVersionMismatch } from "@ngocbh/yian"
import { HarnessError } from "../../src/chat/state.ts"
import { loadConfined } from "../../src/company/flows.ts"
import { CompanyGit } from "../../src/company/git.ts"
import {
  applyProposal,
  MANAGER_FLOW,
  ProposalNotFound,
  ProposalNotOpen,
  profileTools,
  propose,
} from "../../src/profile/manager.ts"
import { GitProfileStore } from "../../src/profile/store.ts"
import { writePrivate } from "../../src/secrets.ts"
import type { FakeLLM } from "../../src/testing/fake_llm.ts"
import { fakeLlm, makeHarness, ROOT, running, status, texts } from "../chat/helpers.ts"
import { company, git } from "../company/helpers.ts"
import { CEO, request, served } from "../daemon/helpers.ts"
import { tempDir, waitFor } from "../helpers.ts"
import { openStore, recordEvents, session } from "../store/helpers.ts"

setDefaultTimeout(30_000)

/** A base company repo, a `CompanyGit` on it, and a store with a profile-manager session of minh's and its
 *  profile tools (Python's `office` fixture). */
function office({ maxChars = 32000 }: { maxChars?: number } = {}) {
  const dir = tempDir()
  const g = new CompanyGit(company(dir), path.join(dir, "worktrees"))
  const store = openStore()
  const s = store.createSession(session({ kind: "profile_manager" }))
  return { git: g, store, s, tools: profileTools(store, new GitProfileStore(g, "minh"), s, { maxChars }) }
}

const subject = (g: CompanyGit) => git(g.root, "log", "-1", "--format=%s")

/** What `promise` rejects with; throws if it fulfils. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("expected a rejection")
}

async function readProfile(tools: ReturnType<typeof profileTools>): Promise<{ text: string; version: string }> {
  return (await tools.read.call({})) as { text: string; version: string }
}

test("the profile manager template loads", async () => {
  const flow = await loadConfined(ROOT, path.join(ROOT, MANAGER_FLOW))
  expect(flow.name).toBe("profile_manager")
})

test("propose edit stores a proposal with its diff and replaces older ones", async () => {
  const { store, s, tools } = office()
  const read = await readProfile(tools)
  expect(read.text).toBe("# Minh, Engineer\n")
  const first = (await tools.propose_edit.call({ text: "# Minh\n", base_version: read.version })) as string
  const second = (await tools.propose_edit.call({
    text: "# Minh, Engineer\n\n- Be brief.\n",
    base_version: read.version,
  })) as string
  const proposals = store.listProfileProposals("minh")
  expect(new Set(proposals.map((p) => p.status))).toEqual(new Set(["open", "discarded"]))
  const latest = store.listProfileProposals("minh", { status: "open" })[0]!
  expect(second).toContain(latest.id)
  expect(first).not.toContain(latest.id)
  expect(second).toBe(`Proposed edit ${latest.id}. The owner can apply it from the profile view.`)
  expect([latest.session_id, latest.base_version, latest.text]).toEqual([
    s.id,
    read.version,
    "# Minh, Engineer\n\n- Be brief.\n",
  ])
  const lines = latest.diff.split("\n")
  expect(lines.slice(0, 2)).toEqual(["--- a/people/minh/profile.md", "+++ b/people/minh/profile.md"])
  expect(lines).toContain("+- Be brief.")
  // difflib's whole output for this edit
  expect(latest.diff).toBe(
    "--- a/people/minh/profile.md\n+++ b/people/minh/profile.md\n@@ -1 +1,3 @@\n # Minh, Engineer\n+\n+- Be brief.\n",
  )
  const made = tools.propose_edit.call({ text: "x", base_version: "0".repeat(40) })
  await expect(made).rejects.toBeInstanceOf(RangeError)
})

const HEADERS = "--- a/people/minh/profile.md\n+++ b/people/minh/profile.md\n"

/** `n` lines `<prefix><i>\n`, every second one `<other><i>\n` when `other` is given. */
function numbered(n: number, prefix: string, other?: string): string[] {
  return Array.from({ length: n }, (_, i) => `${other !== undefined && i % 2 ? other : prefix}${i}\n`)
}

/** The diff `propose` stores for `text` over `base`. */
async function diffOf(base: string, text: string): Promise<string> {
  const { git: g, store, s } = office()
  return (await propose(store, s, new GitProfileStore(g, "minh"), "0".repeat(40), base, text)).diff
}

test("a large edit gets one whole-file hunk", async () => {
  // 1200 changed lines on each side is past the diff's edit bound, which a plain diff of them finishes well within
  // its time bound, so only the edit bound makes the single hunk.
  const base = numbered(2400, "l")
  const text = numbered(2400, "l", "m")
  const diff = await diffOf(base.join(""), text.join(""))
  const minus = base.map((line) => `-${line}`).join("")
  const plus = text.map((line) => `+${line}`).join("")
  expect(diff).toBe(`${HEADERS}@@ -1,2400 +1,2400 @@\n${minus}${plus}`)
})

test("the whole-file hunk keeps difflib's last-line handling", async () => {
  const base = numbered(2400, "l").join("").slice(0, -1)
  const text = numbered(2400, "l", "m").join("").slice(0, -1)
  const diff = await diffOf(base, text)
  expect(diff).toContain("\n-l2399+l0\n") // the last old line without its end runs into the first new one
  expect(diff.endsWith("\n+m2399")).toBe(true)
})

test("the whole-file hunk of an empty base", async () => {
  const text = numbered(2400, "l")
  const diff = await diffOf("", text.join(""))
  expect(diff).toBe(`${HEADERS}@@ -0,0 +1,2400 @@\n${text.map((line) => `+${line}`).join("")}`)
})

test("propose_edit refuses text over 4x the budget", async () => {
  const { store, tools } = office({ maxChars: 10 })
  const { version } = await readProfile(tools)
  const over = `${"😀".repeat(2)}${"x".repeat(39)}` // 41 code points, 43 UTF-16 units
  const error = await rejection(tools.propose_edit.call({ text: over, base_version: version }))
  expect(error).toBeInstanceOf(RangeError)
  expect((error as Error).message).toMatch(/41 characters.*at most 40/)
  expect((error as Error).message).not.toContain("xxx")
  expect(store.listProfileProposals("minh")).toEqual([])
  await tools.propose_edit.call({ text: over.slice(0, -1), base_version: version })
  expect(store.listProfileProposals("minh")).toHaveLength(1)
})

test("propose_edit refuses a lone surrogate", async () => {
  const { store, tools } = office()
  const { version } = await readProfile(tools)
  const error = await rejection(tools.propose_edit.call({ text: "# Minh\ud800\n", base_version: version }))
  expect(error).toBeInstanceOf(RangeError)
  expect(store.listProfileProposals("minh")).toEqual([])
})

test("apply commits the proposal as the owner via the profile manager", async () => {
  const { git: g, store, tools } = office()
  await tools.propose_edit.call({ text: "# Minh\n", base_version: (await readProfile(tools)).version })
  const proposal = store.listProfileProposals("minh", { status: "open" })[0]!
  const events = recordEvents(store)
  const profile = await applyProposal(store, g, proposal.id, { owner: "ngocbh", maxChars: 5 })
  expect([profile.person, profile.text, profile.over_budget]).toEqual(["minh", "# Minh\n", true])
  expect(profile.version).toBe((await new GitProfileStore(g, "minh").read())[1])
  expect(subject(g)).toBe("profile(@minh): ngocbh via profile manager")
  const applied = store.getProfileProposal(proposal.id)!
  expect([applied.status, applied.commit]).toEqual(["applied", await g.head()])
  expect(events.map((e) => e.type).slice(-2)).toEqual(["profile_proposal.updated", "profile.updated"])
  const again = await rejection(applyProposal(store, g, proposal.id, { owner: "ngocbh", maxChars: 5 }))
  expect(again).toBeInstanceOf(ProposalNotOpen)
  expect((again as Error).message).toMatch(/is applied/)
  const unknown = applyProposal(store, g, "01J00000000000000000000000", { owner: "ngocbh", maxChars: 5 })
  await expect(unknown).rejects.toBeInstanceOf(ProposalNotFound)
})

test("apply after a hand edit is a conflict and the proposal goes stale", async () => {
  const { git: g, store, tools } = office()
  await tools.propose_edit.call({ text: "# Minh\n", base_version: (await readProfile(tools)).version })
  const proposal = store.listProfileProposals("minh", { status: "open" })[0]!
  const file = path.join(g.root, "people/minh/profile.md")
  fs.writeFileSync(file, "# Minh, Staff Engineer\n")
  const error = await rejection(applyProposal(store, g, proposal.id, { owner: "ngocbh", maxChars: 100 }))
  expect(error).toBeInstanceOf(MarkdownVersionMismatch)
  expect((error as MarkdownVersionMismatch).expected).toBe(proposal.base_version)
  expect((error as MarkdownVersionMismatch).current).toBe((await new GitProfileStore(g, "minh").read())[1])
  expect(store.getProfileProposal(proposal.id)!.status).toBe("stale")
  expect(fs.readFileSync(file, "utf8")).toBe("# Minh, Staff Engineer\n")
})

test("a proposal made while another is applied waits for the apply", async () => {
  const { git: g, store, tools } = office()
  const version = (await readProfile(tools)).version
  await tools.propose_edit.call({ text: "# Minh\n", base_version: version })
  const proposal = store.listProfileProposals("minh", { status: "open" })[0]!
  const write = GitProfileStore.prototype.write
  onTestFinished(() => {
    GitProfileStore.prototype.write = write
  })
  const newer: Promise<unknown>[] = []
  const openDuringWrite: string[][] = []
  GitProfileStore.prototype.write = async function (this: GitProfileStore, ...args: Parameters<typeof write>) {
    newer.push(tools.propose_edit.call({ text: "# M\n", base_version: version }))
    // It discards the proposal now unless applying holds it back.
    await new Promise((resolve) => setTimeout(resolve, 500))
    openDuringWrite.push(store.listProfileProposals("minh", { status: "open" }).map((p) => p.id))
    return await write.apply(this, args)
  }
  const profile = await applyProposal(store, g, proposal.id, { owner: "ngocbh", maxChars: 100 })
  await newer[0]
  expect(openDuringWrite).toEqual([[proposal.id]])
  expect(profile.text).toBe("# Minh\n")
  expect(store.getProfileProposal(proposal.id)!.status).toBe("applied")
  expect(store.listProfileProposals("minh", { status: "open" }).map((p) => p.text)).toEqual(["# M\n"])
})

// The profile manager's chat, through the chat harness over the fake LLM (Python's
// `tests/profile/test_learning_manager.py`).

const MINH = "# Minh, Engineer\n"

/** A chat harness over the fake LLM whose company has the template's profile manager flow, and a second
 *  connection on model `stub-2`. */
function managerHarness(fake: FakeLLM) {
  const files = { [MANAGER_FLOW]: fs.readFileSync(path.join(ROOT, MANAGER_FLOW), "utf8") }
  return makeHarness(fake, { files, connections: { second: "stub-2" } })
}

type ManagerHarness = Awaited<ReturnType<typeof managerHarness>>

const profileText = (h: ManagerHarness) =>
  fs.readFileSync(path.join(h.office.git.root, "people/minh/profile.md"), "utf8")

/** Applies proposal `id` as `owner`, as the apply route does. */
const apply = (h: ManagerHarness, id: string, owner = CEO) =>
  applyProposal(h.store, h.office.git, id, { owner, maxChars: 10_000 })

/** Waits for the session's next turn, then ends it. */
async function endChat(h: ManagerHarness, sid: string): Promise<void> {
  await waitFor(() => status(h, sid) === "idle", { what: "the next turn" })
  await h.harness.end(sid)
  await waitFor(() => status(h, sid) === "ended", { what: "ended" })
}

test("the profile manager proposes an edit that the owner applies", async () => {
  const fake = await fakeLlm()
  const h = await managerHarness(fake)
  const version = (await new GitProfileStore(h.office.git, "minh").read())[1]
  const edited = `${MINH}\n- Likes short replies.\n`
  fake.script(
    { tool_calls: [{ name: "propose_edit", arguments: { text: edited, base_version: version } }] },
    { content: "I proposed the edit." },
  )
  const s = await h.harness.startManager("minh", "Say that I like short replies.")
  expect([s.kind, s.person, s.work_item_id]).toEqual(["profile_manager", "minh", null])
  expect(s.cwd).toBe(fs.realpathSync(h.office.git.root))
  await waitFor(() => texts(h, s.id).join() === "I proposed the edit.", { what: "the reply" })
  expect(JSON.stringify(fake.requests()[0]!.messages)).toContain("Say that I like short replies.")
  const [proposal, ...rest] = h.store.listProfileProposals("minh")
  expect(rest).toEqual([])
  expect([proposal!.session_id, proposal!.base_version, proposal!.text, proposal!.status]).toEqual([
    s.id,
    version,
    edited,
    "open",
  ])
  expect(profileText(h)).toBe(MINH) // nothing changes until the owner applies it

  const profile = await apply(h, proposal!.id)
  expect([profile.text, profile.version]).toEqual([edited, (await new GitProfileStore(h.office.git, "minh").read())[1]])
  expect(subject(h.office.git)).toBe("profile(@minh): ngocbh via profile manager")
  expect(h.store.listProfileProposals("minh")[0]!.status).toBe("applied")
  expect(await rejection(apply(h, proposal!.id))).toBeInstanceOf(ProposalNotOpen)
  await endChat(h, s.id)
})

test("the profile manager is opened and applied by who acted", async () => {
  const fake = await fakeLlm()
  const h = await managerHarness(fake)
  const version = (await new GitProfileStore(h.office.git, "minh").read())[1]
  fake.script(
    { tool_calls: [{ name: "propose_edit", arguments: { text: `${MINH}- x\n`, base_version: version } }] },
    { content: "Proposed." },
  )
  const s = await h.harness.startManager("minh", "Add x.", { by: "lan" })
  expect(s.opened_by).toBe("lan")
  await waitFor(() => texts(h, s.id).join() === "Proposed.", { what: "the reply" })
  const users = (await h.harness.messages(s.id)).filter((m) => m.role === "user")
  expect(users.map((m) => m.author)).toEqual(["lan"])
  expect(h.store.getRun(h.store.getSession(s.id)!.run_ids[0]!)!.driver).toBe("lan")
  const [proposal] = h.store.listProfileProposals("minh")
  await apply(h, proposal!.id, "lan")
  expect(subject(h.office.git)).toBe("profile(@minh): lan via profile manager")
  await endChat(h, s.id)
})

test("the profile manager stores the default", async () => {
  const fake = await fakeLlm()
  const h = await managerHarness(fake)
  await h.office.connections.setDefault("second")
  fake.script({ content: "Hello." })
  const s = await h.harness.startManager("minh", "Hi.")
  expect([s.connection, s.model]).toEqual(["second", null])
  await waitFor(() => texts(h, s.id).join() === "Hello.", { what: "the reply" })
  expect(fake.requests()[0]!.model).toBe("stub-2")
  await endChat(h, s.id)
})

test("the profile manager says when the default cant be read", async () => {
  const fake = await fakeLlm()
  const h = await managerHarness(fake)
  await writePrivate(path.join(h.office.connections.dir, "_default.json"), "[]")
  fake.script({ content: "Hello." })
  const s = await h.harness.startManager("minh", "Hi.")
  expect([s.connection, s.model, s.model_note]).toEqual([
    "office",
    null,
    "The office's default connection can't be read; this chat uses office/stub.",
  ])
  expect(h.logs.join("\n")).toContain("default connection can't be read")
  await waitFor(() => texts(h, s.id).join() === "Hello.", { what: "the reply" })
  await endChat(h, s.id)
})

test("the profile manager says when the default cant be used", async () => {
  const fake = await fakeLlm()
  const h = await managerHarness(fake)
  await writePrivate(path.join(h.office.connections.dir, "third.json"), "{not json")
  await h.office.connections.setDefault("third")
  fake.script({ content: "Hello." })
  const s = await h.harness.startManager("minh", "Hi.")
  expect([s.connection, s.model, s.model_note]).toEqual([
    "office",
    null,
    "The office's default connection 'third' can't be used; this chat uses office/stub.",
  ])
  expect(h.logs.join("\n")).toContain("the office's default connection 'third' can't be used")
  expect(h.logs.join("\n")).not.toContain(h.office.connections.dir)
  await waitFor(() => texts(h, s.id).join() === "Hello.", { what: "the reply" })
  await endChat(h, s.id)
})

test("a profile manager survives a restart", async () => {
  const fake = await fakeLlm()
  const h = await managerHarness(fake)
  fake.script({ content: "Hello." }, { content: "Still here." })
  const s = await h.harness.startManager("minh", "Hi.", { by: "lan" })
  await waitFor(() => texts(h, s.id).join() === "Hello." && status(h, s.id) === "idle", { what: "the reply" })
  await waitFor(() => !running(h.registry, s.id), { what: "the run call to end" })
  await h.reopen()

  await h.harness.restore()
  expect([status(h, s.id), h.registry.get(s.id)]).toEqual(["idle", undefined])
  await h.harness.prompt(s.id, "Are you there?", { by: "lan" })
  await waitFor(() => texts(h, s.id).at(-1) === "Still here." && status(h, s.id) === "idle", { what: "the next reply" })
  // The same run continues, with its history and its profile tools.
  const sent = JSON.stringify(fake.requests()[1]!.messages)
  expect(sent).toContain("Hi.")
  expect(sent).toContain("Hello.")
  expect(JSON.stringify(fake.requests()[1]!.tools ?? [])).toContain("propose_edit")
  const runs = h.store.getSession(s.id)!.run_ids
  expect(runs).toHaveLength(1)
  expect(h.store.getRun(runs[0]!)!.driver).toBe("lan")
  await endChat(h, s.id)
})

test("the profile manager needs a known person", async () => {
  const h = await managerHarness(await fakeLlm())
  const error = await rejection(h.harness.startManager("nobody", "hi"))
  expect(error).toBeInstanceOf(HarnessError)
  expect([(error as HarnessError).status, (error as HarnessError).code]).toEqual([404, "not_found"])
  const { sock } = await served(h.office)
  expect((await request(sock, "GET", "/profiles/nobody/proposals")).status).toBe(404)
  expect(h.store.listSessions({ kind: "profile_manager" })).toEqual([])
})

test("the profile manager names a person whose file doesnt load", async () => {
  const files = {
    [MANAGER_FLOW]: fs.readFileSync(path.join(ROOT, MANAGER_FLOW), "utf8"),
    "people/minh/person.yaml": "handle: [\n",
  }
  const h = await makeHarness(await fakeLlm(), { files })
  const error = (await rejection(h.harness.startManager("minh", "hi"))) as HarnessError
  expect([error.status, error.code, error.message]).toEqual([404, "not_found", "@minh's person.yaml doesn't load; run `opencorp doctor`"])
  expect(h.store.listSessions({ kind: "profile_manager" })).toEqual([])
})

test("the profile manager needs the manager flow", async () => {
  const h = await makeHarness(await fakeLlm())
  const error = await rejection(h.harness.startManager("minh", "hi"))
  expect(error).toBeInstanceOf(HarnessError)
  expect([(error as HarnessError).status, (error as HarnessError).code]).toEqual([422, "no_manager_flow"])
  expect(h.store.listSessions({ kind: "profile_manager" })).toEqual([])
})

test("a store error while applying is not a not open conflict", async () => {
  const { git: g, store, tools } = office()
  await tools.propose_edit.call({ text: "# Minh\n", base_version: (await readProfile(tools)).version })
  const [proposal] = store.listProfileProposals("minh")
  const write = GitProfileStore.prototype.write
  onTestFinished(() => {
    GitProfileStore.prototype.write = write
  })
  GitProfileStore.prototype.write = async () => {
    throw new Error("people/minh/profile.md goes through a symlink; not writing it")
  }
  const error = await rejection(applyProposal(store, g, proposal!.id, { owner: "ngocbh", maxChars: 100 }))
  expect(error).not.toBeInstanceOf(ProposalNotOpen)
  expect((error as Error).message).toMatch(/symlink/)
  expect(store.listProfileProposals("minh")[0]!.status).toBe("open")
})

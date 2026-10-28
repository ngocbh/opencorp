/** The office's Codex sessions: what `CodexSessions` keeps beyond one session's app-server and turns. */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { HarnessError } from "../../src/chat/state.ts"
import * as fc from "../../src/testing/fake_codex.ts"
import { person } from "../company/helpers.ts"
import { CEO, ULID } from "../daemon/helpers.ts"
import { tempDir, waitFor } from "../helpers.ts"
import { question, session } from "../store/helpers.ts"
import { type Codex, allGone, makeCodex, start, startSession, status, texts } from "./helpers.ts"

setDefaultTimeout(30_000)
afterAll(allGone)

/** The session's current turn as `[role, its text parts]` pairs. */
function shape(h: Codex, sid: string): [string, string[]][] {
  return h.sessions
    .currentTurn(sid)
    .map((m) => [m.role, m.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))])
}

/** The user texts of the session's current turn. */
function userTexts(h: Codex, sid: string): string[] {
  return shape(h, sid)
    .filter(([role]) => role === "user")
    .flatMap(([, parts]) => parts)
}

test("the current turn holds the turn in progress then the last turn until the next message starts one", async () => {
  const h = makeCodex()
  const hello = fc.agentMessage("m1", "Hello there")
  h.fake.script([
    [hello[0], fc.agentMessageDelta("m1", "Hello "), { sleep: 1 }, fc.agentMessageDelta("m1", "there"), hello[3]],
    fc.agentMessage("m2", "Second"),
  ])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "one", { by: "ngocbh" })
  // The first chunk is a part.updated, the rest are part.deltas.
  await waitFor(() => texts(h, sid).includes("Hello "), { what: "the first chunk" })
  expect(shape(h, sid)).toEqual([
    ["user", ["one"]],
    ["assistant", ["Hello "]],
  ])
  await waitFor(() => status(h, sid) === "idle", { what: "the first turn's end" })
  expect(shape(h, sid)).toEqual([
    ["user", ["one"]],
    ["assistant", ["Hello there"]],
  ])
  // The user message is emitted before prompt's first await.
  const prompting = h.sessions.prompt(sid, "two")
  expect(shape(h, sid)).toEqual([["user", ["two"]]])
  await prompting
  await waitFor(() => status(h, sid) === "idle" && texts(h, sid).includes("Second"), { what: "the second turn" })
  expect(shape(h, sid)).toEqual([
    ["user", ["two"]],
    ["assistant", ["Second"]],
  ])
  await h.sessions.end(sid)
  await waitFor(() => status(h, sid) === "ended", { what: "the end" })
  expect(h.sessions.currentTurn(sid)).toEqual([])
})

test("a steer and messages queued during a load join the turn they come in", async () => {
  const h = makeCodex()
  const a = fc.agentMessage("m1", "A")
  h.fake.script([[a[0], { sleep: 1 }, a[3]], fc.agentMessage("m2", "B")], { initialize_delay: 1 })
  const { id: sid } = await startSession(h, "minh", h.workspace, { openedBy: "ngocbh" })
  expect(await h.sessions.prompt(sid, "a")).toBe("queued")
  expect(await h.sessions.prompt(sid, "b")).toBe("queued")
  expect(userTexts(h, sid)).toEqual(["a", "b"])
  await waitFor(() => status(h, sid) === "busy", { what: "the queued turn" })
  expect(await h.sessions.prompt(sid, "c")).toBe("steer")
  expect(userTexts(h, sid)).toEqual(["a", "b", "c"])
})

test("the current turn is a copy and empty for a session that is not live", async () => {
  const h = makeCodex()
  expect(h.sessions.currentTurn("01JA1H0000000000000000000A")).toEqual([])
  h.fake.script([fc.agentMessage("m1", "Done")])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "go")
  await waitFor(() => status(h, sid) === "idle" && texts(h, sid).includes("Done"), { what: "the turn" })
  const got = h.sessions.currentTurn(sid)
  got[0]!.parts.length = 0
  got.length = 0
  const kept = h.sessions.currentTurn(sid)
  expect(kept.length).toBe(2)
  expect(kept[0]!.parts.length).toBe(1)
})

/** What `promise` rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  return promise.then(
    () => {
      throw new Error("expected a rejection")
    },
    (error: unknown) => error as HarnessError,
  )
}

test.each([
  ["no person", {}, (h: Codex) => ["nobody", h.workspace], 404, "not_found"],
  ["not an agent", {}, (h: Codex) => ["ngocbh", h.workspace], 422, "not_an_agent"],
  [
    "no codex",
    // An agent built from minh's file, since the kind check comes first.
    { "people/ava/person.yaml": person("minh", { handle: "ava", name: "Ava", harnesses: ["composer"] }) },
    (h: Codex) => ["ava", h.workspace],
    422,
    "unsupported_harness",
  ],
  ["relative cwd", {}, () => ["minh", "rel/dir"], 422, "invalid_body"],
  ["missing folder", {}, () => ["minh", path.join(tempDir(), "gone")], 422, "invalid_body"],
  [
    "not a folder",
    {},
    () => {
      const file = path.join(tempDir(), "file")
      fs.writeFileSync(file, "")
      return ["minh", file]
    },
    422,
    "invalid_body",
  ],
  [
    "under a file",
    {},
    () => {
      const file = path.join(tempDir(), "file")
      fs.writeFileSync(file, "")
      return ["minh", path.join(file, "below")]
    },
    422,
    "invalid_body",
  ],
  // Absolute, so it reaches the folder check.
  ["nul byte", {}, () => ["minh", path.join(tempDir(), "a\u0000b")], 422, "invalid_body"],
  ["root", {}, () => ["minh", "/"], 422, "unsafe_workspace"],
  ["office files", {}, (h: Codex) => ["minh", h.office.paths.company], 422, "unsafe_workspace"],
  [
    "office guards",
    {},
    (h: Codex) => {
      // A daemon PATH entry inside the workspace: the start checks the folder with the office's guards.
      h.office.guards.path = [path.join(h.workspace, "bin")]
      return ["minh", h.workspace]
    },
    422,
    "unsafe_workspace",
  ],
] as [string, Record<string, unknown>, (h: Codex) => string[], number, string][])(
  "start session refuses before any write [%s]",
  async (name, files, setup, status, code) => {
    const h = makeCodex({ files })
    const [handle, cwd] = setup(h)
    const error = await rejection(h.sessions.startSession(handle!, cwd!, { openedBy: "ngocbh" }))
    expect(error).toBeInstanceOf(HarnessError)
    expect([error.status, error.code]).toEqual([status, code])
    // A 422 never echoes a path the request gave that isn't a usable folder.
    if (code === "invalid_body") expect(error.message).not.toContain(cwd!)
    // Nor any other value of the request: it says which field failed, and the office log says why.
    if (status === 422) {
      expect(error.message).not.toContain(handle!)
      expect(error.message).not.toContain(cwd!)
    }
    if (name === "office guards") expect(h.lines.join("\n")).toContain("a folder on the office's PATH")
    if (name === "office files") expect(h.lines.join("\n")).toContain("overlaps the office's files")
    expect(h.store.listSessions()).toEqual([])
    expect(h.store.listWorkItems()).toEqual([])
  },
)

test("a refused folder's name can't add a line to the office log", async () => {
  const h = makeCodex()
  const cwd = path.join(h.office.paths.company, "a\nforged line")
  fs.mkdirSync(cwd, { recursive: true })
  const error = await rejection(h.sessions.startSession("minh", cwd, { openedBy: "ngocbh" }))
  expect([error.status, error.code]).toEqual([422, "unsafe_workspace"])
  const refused = h.lines.filter((line) => line.includes("refused"))
  expect(refused).toHaveLength(1)
  expect(refused[0]).toContain("a\\nforged line")
  expect(refused[0]).not.toContain("\n")
})

/** Each session call a yian chat isn't served for yet. */
const CALLS: [string, (h: Codex, id: string) => Promise<unknown>][] = [
  ["prompt", (h, id) => h.sessions.prompt(id, "sk-sentinel")],
  ["steer", (h, id) => h.sessions.steer(id, "sk-sentinel")],
  ["end", (h, id) => h.sessions.end(id)],
  ["setCostCap", (h, id) => h.sessions.setCostCap(id, 10)],
  ["setModel", (h, id) => h.sessions.setModel(id, "office", "sk-sentinel")],
  ["messages", (h, id) => Promise.resolve().then(() => h.sessions.messages(id))],
]

test.each(CALLS)("a session on another harness is not served yet [%s]", async (_name, call) => {
  const h = makeCodex()
  const s = h.store.createSession(session({ harness: "composer", status: "idle" }))
  const chat = await rejection(call(h, s.id))
  expect(chat).toBeInstanceOf(HarnessError)
  expect([chat.status, chat.code]).toEqual([501, "not_implemented"])
  expect(chat.message).not.toContain("sk-sentinel")
  const missing = await rejection(call(h, ULID))
  expect(missing).toBeInstanceOf(HarnessError)
  expect([missing.status, missing.code]).toEqual([404, "not_found"])
  expect(h.store.getSession(s.id)).toEqual(s)
})

test.each([
  ["composer", 501, "not_implemented"],
  ["claude", 422, "unsupported_harness"],
] as const)("a start on another harness is refused before any write [%s]", async (harness, status, code) => {
  const h = makeCodex()
  const error = await rejection(h.sessions.startSession("minh", h.workspace, { harness, openedBy: "ngocbh" }))
  expect(error).toBeInstanceOf(HarnessError)
  expect([error.status, error.code]).toEqual([status, code])
  expect(h.store.listSessions()).toEqual([])
})

test("a start whose default connection cant be read takes office and says so", async () => {
  const h = makeCodex()
  h.office.connections.ensureDir()
  fs.writeFileSync(path.join(h.office.connections.dir, "_default.json"), JSON.stringify({ x: 1 }), { mode: 0o600 })
  const row = await h.sessions.startSession("minh", h.workspace, { openedBy: "ngocbh" })
  expect(row.connection).toBe("office")
  expect(h.lines).toContain("the office's default connection can't be read; new chats take office as the default")
  await waitFor(() => status(h, row.id) === "idle", { what: "the load" })
})

test("an answer to a question of a session on another harness is stored for the caller or the opener", async () => {
  const h = makeCodex()
  const s = h.store.createSession(
    session({ harness: "composer", status: "waiting", repo_commit: await h.office.git.head(), opened_by: null }),
  )
  const q1 = h.store.addQuestion(question(s.id))
  const q2 = h.store.addQuestion(question(s.id))
  const first = await h.sessions.answer(q1.id, "Postgres", "text", { by: "ava" })
  expect([first.status, first.answer, first.answered_by]).toEqual(["answered", "Postgres", "ava"])
  // No caller named and no opener: the pinned company's CEO.
  expect((await h.sessions.answer(q2.id, "x", "text")).answered_by).toBe(CEO)
  const again = await rejection(h.sessions.answer(q1.id, "MySQL", "text", { by: "ava" }))
  expect(again).toBeInstanceOf(HarnessError)
  expect([again.status, again.code]).toEqual([409, "not_open"])
})

test("esc on a live session on another harness leaves its questions open", async () => {
  const h = makeCodex()
  const s = h.store.createSession(session({ harness: "composer", status: "waiting" }))
  const asked = h.store.addQuestion(question(s.id, { source: "ask_user" }))
  const managed = h.store.addQuestion(question(s.id, { source: "ask_manager" }))
  // No run of it is live here, so nothing runs to stop.
  await h.sessions.interrupt(s.id)
  expect(h.store.getQuestion(asked.id)!.status).toBe("open")
  expect(h.store.getQuestion(managed.id)!.status).toBe("open")
  expect(h.store.getSession(s.id)).toEqual(s)
})

test("esc on a session on another harness that is not live is 409 and a missing one 404", async () => {
  const h = makeCodex()
  const s = h.store.createSession(session({ harness: "composer", status: "ended" }))
  const ended = await rejection(h.sessions.interrupt(s.id))
  expect(ended).toBeInstanceOf(HarnessError)
  expect([ended.status, ended.code]).toEqual([409, "not_live"])
  const missing = await rejection(h.sessions.interrupt(ULID))
  expect([missing.status, missing.code]).toEqual([404, "not_found"])
})

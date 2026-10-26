/** The chat harness: a start, its run spec, what a start refuses, and how it hands Codex sessions to the Codex
 *  sessions (Python's `tests/chat/test_harness.py`). */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { HarnessError } from "../../src/chat/state.ts"
import type { SessionRecord } from "../../src/store/store.ts"
import { person } from "../company/helpers.ts"
import { CODEX_PERSON, allGone } from "../harness/helpers.ts"
import { tempDir, waitFor } from "../helpers.ts"
import { session } from "../store/helpers.ts"
import { LAN, fakeLlm, makeHarness, noWorkersLeft, status } from "./helpers.ts"

setDefaultTimeout(60_000)
afterAll(async () => {
  await allGone()
  await noWorkersLeft()
})

const MINH = {
  name: "Minh",
  handle: "minh",
  title: "Engineer",
  company: "test-corp",
  reports_to: "You report to Hong Ngoc Bui (@ngocbh).",
}
const TALKING_TO_CEO = "You're talking with Hong Ngoc Bui (@ngocbh), the CEO and your manager."

type Harness = Awaited<ReturnType<typeof makeHarness>>

/** What `promise` rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  return promise.then(
    () => {
      throw new Error("expected a rejection")
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(HarnessError)
      return error as HarnessError
    },
  )
}

/** Starts minh's chat in `h.folder` (`options` as `startSession`'s) and waits for its first turn; returns it as
 *  stored. */
async function start(h: Harness, options: Parameters<Harness["harness"]["startSession"]>[2] = {}) {
  const s = await h.harness.startSession("minh", h.folder, options)
  await waitFor(() => status(h, s.id) === "idle", { what: "the first turn" })
  return h.store.getSession(s.id)!
}

/** A stored idle main chat of minh's in `h.folder` at the company's head, with `over`. */
async function stored(h: Harness, over: Partial<SessionRecord> = {}): Promise<SessionRecord> {
  return h.store.createSession(session({ cwd: h.folder, repo_commit: await h.office.git.head(), ...over }))
}

/** Records the status of each session `h`'s hooks see end. */
function endings(h: Harness): string[] {
  const ended: string[] = []
  h.hooks.sessionEnded.push((s: SessionRecord) => void ended.push(s.status))
  return ended
}

test("a session records who opened it and its work item is theirs", async () => {
  const h = await makeHarness(await fakeLlm(), { files: LAN })
  const opened = await start(h, { openedBy: "lan" })
  expect([opened.opened_by, h.store.getWorkItem(opened.work_item_id!)!.requester]).toEqual(["lan", "lan"])
  const unsaid = await start(h)
  expect([unsaid.opened_by, h.store.getWorkItem(unsaid.work_item_id!)!.requester]).toEqual([null, "ngocbh"])
})

test("a main run gets the persons identity and who they talk with", async () => {
  const h = await makeHarness(await fakeLlm())
  const spec = await h.harness.spec(await stored(h))
  expect(spec.inputs).toEqual({ person: MINH, talking_to: TALKING_TO_CEO, max_turns: 500 })
})

test("a main run is told who opened it", async () => {
  const h = await makeHarness(await fakeLlm(), { files: LAN })
  const spec = await h.harness.spec(await stored(h, { opened_by: "lan" }))
  expect(spec.inputs.talking_to).toBe("You're talking with Lan (@lan), your peer.")
})

test("a main run offers toolbox workspace and company in that order", async () => {
  const h = await makeHarness(await fakeLlm())
  const s = await stored(h)
  const groups = (await h.harness.spec(s)).groups({ session: s, runId: "run-1" })
  expect(Object.entries(groups).map(([group, tools]) => [group, Object.keys(tools)])).toEqual([
    ["toolbox", ["fake__echo"]],
    ["workspace", ["read_file", "write_file", "edit_file", "list", "search", "shell"]],
    ["company", ["ask_manager", "create_work_item", "comment"]],
  ])
})

test("the run spec keeps its tmp dir private under the session folder", async () => {
  const h = await makeHarness(await fakeLlm())
  const s = await stored(h)
  await h.harness.spec(s)
  const tmp = path.join(h.office.paths.office, "sessions", s.id, "tmp")
  expect(fs.statSync(tmp).mode & 0o777).toBe(0o700)
})

test("a session records the resolved folder", async () => {
  const h = await makeHarness(await fakeLlm())
  const link = path.join(tempDir(), "link")
  fs.symlinkSync(h.folder, link)
  const s = await h.harness.startSession("minh", link)
  await waitFor(() => status(h, s.id) === "idle", { what: "the first turn" })
  const real = fs.realpathSync(h.folder)
  expect(s.cwd).toBe(real)
  expect(h.store.workedFolders("minh").map((f) => f.cwd)).toEqual([real])
})

test("a person with no harnesses list chats on the composer", async () => {
  const h = await makeHarness(await fakeLlm(), { files: { "people/minh/person.yaml": person("minh", { harnesses: [] }) } })
  expect((await start(h)).harness).toBe("composer")
})

test("a chat starts on the picked connection and stores the connections own model as null", async () => {
  const h = await makeHarness(await fakeLlm(), { connections: { alt: "alt-model" } })
  const picks = [
    { connection: "alt", model: "other" },
    { connection: "alt", model: "alt-model" },
    { connection: "nope", model: "other" },
  ]
  const started = []
  for (const pick of picks) started.push(await start(h, pick))
  expect(started.map((s) => [s.connection, s.model])).toEqual([
    ["alt", "other"],
    ["alt", null],
    ["office", null],
  ])
})

test("a provider error at start fails the session", async () => {
  const h = await makeHarness(await fakeLlm())
  const file = path.join(h.office.connections.dir, "office.json")
  fs.chmodSync(file, 0o644) // not private: the connection is refused
  const ended = endings(h)
  const error = await rejection(h.harness.startSession("minh", h.folder))
  const [s, ...rest] = h.store.listSessions()
  expect(rest).toEqual([])
  expect([error.status, error.code]).toEqual([500, "start_failed"])
  expect(error.message.startsWith(`session ${s!.id} failed to start: `)).toBe(true)
  expect(error.message).toContain(file)
  expect(error.message).toContain("private")
  expect(s!.status).toBe("failed")
  await waitFor(() => ended.length > 0, { what: "the session to end" })
  expect(ended).toEqual(["failed"])
  const late = await rejection(h.harness.prompt(s!.id, "hi"))
  expect(late.code).toBe("not_live")
})

test("a run that cant be set up fails the session and says so", async () => {
  const h = await makeHarness(await fakeLlm())
  const ended = endings(h)
  spyOn(h.store, "addSessionRun").mockImplementation(() => {
    throw new Error("disk full")
  })
  const error = await rejection(h.harness.startSession("minh", h.folder))
  expect([error.status, error.code]).toEqual([500, "start_failed"])
  expect(error.message).not.toContain("disk full")
  await waitFor(() => ended.length > 0, { what: "the session to end" })
  expect([h.store.listSessions().map((s) => s.status), ended]).toEqual([["failed"], ["failed"]])
})

test("a start that fails otherwise names the session but not the error", async () => {
  const h = await makeHarness(await fakeLlm())
  spyOn(h.registry, "spawn").mockRejectedValue(new Error("sentinel detail"))
  const error = await rejection(h.harness.startSession("minh", h.folder))
  const [s, ...rest] = h.store.listSessions()
  expect(rest).toEqual([])
  expect([error.status, error.code, s!.status]).toEqual([500, "start_failed", "failed"])
  expect(error.message).toContain(s!.id)
  expect(error.message).not.toContain("sentinel")
})

test.each([
  ["unknown person", "nobody", null, "not_found"],
  ["human", "ngocbh", null, "not_an_agent"],
  ["relative cwd", "minh", "relative/path", "invalid_body"],
  ["root cwd", "minh", "/", "unsafe_workspace"],
] as const)("start refuses bad requests [%s]", async (_case, handle, cwd, code) => {
  const h = await makeHarness(await fakeLlm())
  const error = await rejection(h.harness.startSession(handle, cwd ?? h.folder))
  expect(error.code).toBe(code)
  expect(h.store.listSessions()).toEqual([])
  // Refused before anything of the session is written.
  expect(fs.existsSync(h.office.paths.runs)).toBe(false)
})

test.each([
  ["home", ""],
  ["company", "company"],
  ["office", "office"],
  ["office/runs", "office/runs"],
])("start refuses the offices own folders [%s]", async (_label, where) => {
  const h = await makeHarness(await fakeLlm())
  const paths = h.office.paths
  const cwd = path.join(paths.home, where)
  fs.mkdirSync(cwd, { recursive: true })
  const error = await rejection(h.harness.startSession("minh", cwd))
  expect([error.status, error.code]).toEqual([422, "unsafe_workspace"])
  expect(h.store.listSessions()).toEqual([])
  expect(!fs.existsSync(paths.runs) || fs.readdirSync(paths.runs).length === 0).toBe(true)
})

test("a codex chat is stored then handed to the codex sessions", async () => {
  const h = await makeHarness(await fakeLlm(), { codex: true })
  const start = spyOn(h.codex!.sessions, "start")
  const s = await h.harness.startSession("minh", h.folder, { harness: "codex", openedBy: "ngocbh" })
  expect(start.mock.calls.map(([row, options]) => [row.status, row.harness, options?.resume ?? false])).toEqual([
    ["starting", "codex", false],
  ])
  expect([s.harness, s.opened_by]).toEqual(["codex", "ngocbh"])
  expect(s.work_item_id).toBeTruthy()
})

test("codex needs the codex sessions", async () => {
  const h = await makeHarness(await fakeLlm(), { files: CODEX_PERSON })
  const error = await rejection(h.harness.startSession("minh", h.folder, { harness: "codex" }))
  expect([error.status, error.code]).toEqual([422, "unsupported_harness"])
})

test("codex needs a person who uses it", async () => {
  // minh's harnesses: [composer]
  const h = await makeHarness(await fakeLlm(), { codex: true, files: { "people/minh/person.yaml": person("minh") } })
  const error = await rejection(h.harness.startSession("minh", h.folder, { harness: "codex" }))
  expect([error.status, error.code]).toEqual([422, "unsupported_harness"])
})

test("a codex chat that cant be handed over fails with its id", async () => {
  const h = await makeHarness(await fakeLlm(), { codex: true })
  spyOn(h.codex!.sessions, "start").mockRejectedValue(new Error("sentinel"))
  const ended: string[] = []
  h.hooks.sessionEnded.push((s: SessionRecord) => void ended.push(s.status))
  const error = await rejection(h.harness.startSession("minh", h.folder, { harness: "codex" }))
  expect([error.status, error.code]).toEqual([500, "start_failed"])
  expect(error.message).not.toContain("sentinel")
  const [s, ...rest] = h.store.listSessions()
  expect(rest).toEqual([])
  expect([s!.status, ended]).toEqual(["failed", ["failed"]])
  expect(error.message).toContain(s!.id)
})

test("a codex session can not continue without the codex sessions", async () => {
  const h = await makeHarness(await fakeLlm())
  const stored = h.store.createSession(session({ harness: "codex", harness_session_id: "thr_1", status: "ended" }))
  const error = await rejection(h.harness.continueSession(stored.id, { by: "ngocbh" }))
  expect([error.status, error.code, error.message]).toEqual([
    422,
    "unsupported_harness",
    "the codex harness is not supported yet",
  ])
})

test.each(["setCostCap", "setModel"] as const)(
  "a codex sessions cost cap and model are not supported without the codex sessions [%s]",
  async (call) => {
    const h = await makeHarness(await fakeLlm())
    const stored = h.store.createSession(session({ harness: "codex", harness_session_id: "thr_1" }))
    const error = await rejection(
      call === "setCostCap" ? h.harness.setCostCap(stored.id, 5) : h.harness.setModel(stored.id, "default", "gpt-x"),
    )
    expect([error.status, error.code]).toEqual([422, "not_supported"])
  },
)

test("close closes the workers even when the codex sessions fail to close", async () => {
  const h = await makeHarness(await fakeLlm(), { codex: true })
  spyOn(h.codex!.sessions, "closeAll").mockRejectedValueOnce(new Error("sentinel"))
  const workers = spyOn(h.harness.registry, "closeAll")
  await expect(h.harness.closeAll()).rejects.toThrow("sentinel")
  await expect(h.harness.closeAll()).rejects.toThrow("sentinel")
  expect(workers).toHaveBeenCalledTimes(1)
  // The test's end closes this harness again, which would only report the same rejection.
  spyOn(h.harness, "closeAll").mockResolvedValue()
})

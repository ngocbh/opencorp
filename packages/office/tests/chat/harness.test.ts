/** The chat harness: what a start refuses, and how it hands Codex sessions to the Codex sessions. */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { HarnessError } from "../../src/chat/state.ts"
import type { SessionRecord } from "../../src/store/store.ts"
import { person } from "../company/helpers.ts"
import { CODEX_PERSON, allGone } from "../harness/helpers.ts"
import { session } from "../store/helpers.ts"
import { makeHarness } from "./helpers.ts"

setDefaultTimeout(30_000)
afterAll(allGone)

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

test.each([
  ["unknown person", "nobody", null, "not_found"],
  ["human", "ngocbh", null, "not_an_agent"],
  ["relative cwd", "minh", "relative/path", "invalid_body"],
  ["root cwd", "minh", "/", "unsafe_workspace"],
] as const)("start refuses bad requests [%s]", async (_case, handle, cwd, code) => {
  const h = makeHarness()
  const error = await rejection(h.harness.startSession(handle, cwd ?? h.workspace))
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
  const h = makeHarness()
  const paths = h.office.paths
  const cwd = path.join(paths.home, where)
  fs.mkdirSync(cwd, { recursive: true })
  const error = await rejection(h.harness.startSession("minh", cwd))
  expect([error.status, error.code]).toEqual([422, "unsafe_workspace"])
  expect(h.store.listSessions()).toEqual([])
  expect(!fs.existsSync(paths.runs) || fs.readdirSync(paths.runs).length === 0).toBe(true)
})

test("a codex chat is stored then handed to the codex sessions", async () => {
  const h = makeHarness({ codex: true })
  const start = spyOn(h.codex!.sessions, "start")
  const s = await h.harness.startSession("minh", h.workspace, { harness: "codex", openedBy: "ngocbh" })
  expect(start.mock.calls.map(([row, options]) => [row.status, row.harness, options?.resume ?? false])).toEqual([
    ["starting", "codex", false],
  ])
  expect([s.harness, s.opened_by]).toEqual(["codex", "ngocbh"])
  expect(s.work_item_id).toBeTruthy()
})

test("codex needs the codex sessions", async () => {
  const h = makeHarness({ files: CODEX_PERSON })
  const error = await rejection(h.harness.startSession("minh", h.workspace, { harness: "codex" }))
  expect([error.status, error.code]).toEqual([422, "unsupported_harness"])
})

test("codex needs a person who uses it", async () => {
  // minh's harnesses: [composer]
  const h = makeHarness({ codex: true, files: { "people/minh/person.yaml": person("minh") } })
  const error = await rejection(h.harness.startSession("minh", h.workspace, { harness: "codex" }))
  expect([error.status, error.code]).toEqual([422, "unsupported_harness"])
})

test("a codex chat that cant be handed over fails with its id", async () => {
  const h = makeHarness({ codex: true })
  spyOn(h.codex!.sessions, "start").mockRejectedValue(new Error("sentinel"))
  const ended: string[] = []
  h.hooks.sessionEnded.push((s: SessionRecord) => void ended.push(s.status))
  const error = await rejection(h.harness.startSession("minh", h.workspace, { harness: "codex" }))
  expect([error.status, error.code]).toEqual([500, "start_failed"])
  expect(error.message).not.toContain("sentinel")
  const [s, ...rest] = h.store.listSessions()
  expect(rest).toEqual([])
  expect([s!.status, ended]).toEqual(["failed", ["failed"]])
  expect(error.message).toContain(s!.id)
})

test("a codex session can not continue without the codex sessions", async () => {
  const h = makeHarness()
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
    const h = makeHarness()
    const stored = h.store.createSession(session({ harness: "codex", harness_session_id: "thr_1" }))
    const error = await rejection(
      call === "setCostCap" ? h.harness.setCostCap(stored.id, 5) : h.harness.setModel(stored.id, "default", "gpt-x"),
    )
    expect([error.status, error.code]).toEqual([422, "not_supported"])
  },
)

test("close closes the workers even when the codex sessions fail to close", async () => {
  const h = makeHarness({ codex: true })
  spyOn(h.codex!.sessions, "closeAll").mockRejectedValueOnce(new Error("sentinel"))
  const workers = spyOn(h.harness.registry, "closeAll")
  await expect(h.harness.closeAll()).rejects.toThrow("sentinel")
  await expect(h.harness.closeAll()).rejects.toThrow("sentinel")
  expect(workers).toHaveBeenCalledTimes(1)
  // The office's last stop step closes this harness again, which would only report the same rejection.
  h.office.onStop.pop()
})

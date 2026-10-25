/** Continuing an ended Codex session: a new row on the same thread, resumed. */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { HarnessError } from "../../src/chat/state.ts"
import { ownerLoad } from "../../src/harness/codex.ts"
import { realPath } from "../../src/sandbox/policy.ts"
import * as fc from "../../src/testing/fake_codex.ts"
import { waitFor } from "../helpers.ts"
import { session } from "../store/helpers.ts"
import {
  type Codex,
  allGone,
  errors,
  makeCodex,
  messages,
  requestsValid,
  restarted,
  start,
  status,
  texts,
} from "./helpers.ts"

setDefaultTimeout(30_000)
afterAll(allGone)

/** A Codex session of minh's that ran one turn and ended. */
async function ended(h: Codex, workspace: string, prompt = "one", by = "ngocbh"): Promise<string> {
  const sid = await start(h, workspace, by)
  await h.sessions.prompt(sid, prompt)
  await waitFor(() => status(h, sid) === "idle" && messages(h, sid).at(-1)?.role === "assistant", {
    what: "the first stretch",
  })
  await h.sessions.end(sid)
  await waitFor(() => ["ended", "debriefing"].includes(status(h, sid)!), { what: "ended" })
  return sid
}

/** What `promise` rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  return promise.then(
    () => {
      throw new Error("expected a rejection")
    },
    (error: unknown) => error as HarnessError,
  )
}

test("continuing makes a new row on the same thread and resumes it", async () => {
  const h = makeCodex()
  h.fake.script([
    [...fc.agentMessage("m1", "First"), fc.tokenUsage(1200, 800, 90)],
    [...fc.agentMessage("m2", "Second"), fc.tokenUsage(2000, 1000, 150)],
  ])
  const old = await ended(h, h.workspace)
  const before = h.store.getSession(old)!
  const fresh = await h.sessions.continueSession(old, { by: "ava" })
  const { parent_session_id, harness_session_id, harness, person, cwd, opened_by } = fresh
  expect([parent_session_id, harness_session_id, harness, person, cwd, opened_by]).toEqual([
    old,
    "thr_1",
    "codex",
    "minh",
    before.cwd,
    "ava",
  ])
  expect(fresh.work_item_id).not.toBe(before.work_item_id)
  expect(h.store.getWorkItem(fresh.work_item_id!)!.requester).toBe("ava")
  await waitFor(() => status(h, fresh.id) === "idle", { what: "the resume" })
  const resumes = h.fake.calls("thread/resume")
  expect(resumes.map((c) => (c as { threadId: string }).threadId)).toEqual(["thr_1"])
  expect(resumes[0]).toEqual({
    threadId: "thr_1",
    excludeTurns: true,
    ...ownerLoad(fresh.cwd, { sandbox: "workspace-write", network: false }),
  })
  // Only the first stretch started a thread.
  expect(h.fake.calls("thread/start")).toHaveLength(1)
  await h.sessions.prompt(fresh.id, "two")
  await waitFor(() => texts(h, fresh.id).join() === "Second" && status(h, fresh.id) === "idle", {
    what: "the second stretch",
  })
  await waitFor(() => h.store.getSession(fresh.id)!.harness_usage !== null, { what: "usage" })
  expect(texts(h, old)).toEqual(["First"])
  // Codex counts the whole thread; each stretch keeps only its own tokens.
  expect(h.store.getSession(fresh.id)!.harness_usage).toEqual({
    input_tokens: 800,
    cached_input_tokens: 200,
    output_tokens: 60,
  })
  expect(h.store.getSession(old)).toEqual(before)
  requestsValid(h.fake)
})

test.each(["live", "composer", "missing", "continued"])(
  "only an ended codex session with no live continuation continues [%s]",
  async (kind) => {
    const h = makeCodex()
    const sid = kind !== "missing" ? await start(h, h.workspace) : "01J0000000000000000000000X"
    if (kind === "composer") h.store.updateSession(sid, { harness: "composer", status: "ended" })
    if (kind === "continued") {
      await h.sessions.end(sid)
      await waitFor(() => status(h, sid) === "ended", { what: "ended" })
      const live = await h.sessions.continueSession(sid, { by: "ngocbh" })
      await waitFor(() => status(h, live.id) === "idle", { what: "the resume" })
    }
    const error = await rejection(h.sessions.continueSession(sid, { by: "ngocbh" }))
    expect(error).toBeInstanceOf(HarnessError)
    expect(error.status).toBe({ live: 409, composer: 422, missing: 404, continued: 409 }[kind])
  },
)

test("continuing an older stretch counts only its own tokens", async () => {
  const h = makeCodex()
  h.fake.script([
    [...fc.agentMessage("m1", "A"), fc.tokenUsage(1000, 0, 10)],
    [...fc.agentMessage("m2", "B"), fc.tokenUsage(3000, 0, 30)],
    [...fc.agentMessage("m3", "C"), fc.tokenUsage(3500, 0, 35)],
  ])
  const a = await ended(h, h.workspace)
  let b = ""
  let last = ""
  // Both continue a, the first stretch; the second comes after b on the thread.
  for (const prompt of ["b", "c"]) {
    const s = await h.sessions.continueSession(a, { by: "ngocbh" })
    await waitFor(() => status(h, s.id) === "idle", { what: "the resume" })
    await h.sessions.prompt(s.id, prompt)
    await waitFor(() => h.store.getSession(s.id)!.harness_usage !== null && status(h, s.id) === "idle", {
      what: "the stretch",
    })
    await h.sessions.end(s.id)
    await waitFor(() => status(h, s.id) === "ended", { what: "ended" })
    if (prompt === "b") b = s.id
    last = s.id
  }
  // The thread's chain stays one line.
  expect(h.store.getSession(last)!.parent_session_id).toBe(b)
  expect(h.store.getSession(last)!.harness_usage).toEqual({
    input_tokens: 500,
    cached_input_tokens: 0,
    output_tokens: 5,
  })
})

test("a continued session keeps the connection its debrief runs on", async () => {
  const h = makeCodex()
  h.office.connections.ensureDir()
  fs.writeFileSync(path.join(h.office.connections.dir, "second.json"), "{}", { mode: 0o600 })
  const old = (await h.sessions.startSession("minh", h.workspace, { openedBy: "ngocbh", connection: "second" })).id
  await waitFor(() => status(h, old) === "idle", { what: "the load" })
  expect(h.store.getSession(old)!.connection).toBe("second")
  await h.sessions.end(old)
  await waitFor(() => status(h, old) === "ended", { what: "ended" })
  const fresh = await h.sessions.continueSession(old, { by: "ngocbh" })
  expect([fresh.connection, fresh.model]).toEqual(["second", null])
  await waitFor(() => status(h, fresh.id) === "idle", { what: "the resume" })
})

test("why a session can not continue", async () => {
  const h = makeCodex()
  h.fake.script([], { initialize_error: { code: -32600, message: "nope" } })
  const never = (await h.sessions.startSession("minh", h.workspace, { openedBy: "ngocbh" })).id
  await waitFor(() => status(h, never) === "failed", { what: "failed" })
  const composer = h.store.createSession(session({ status: "ended" }))
  for (const [sid, why] of [
    [never, "this Codex session never loaded its thread, so there is nothing to continue"],
    [composer.id, "only a Codex session can be continued"],
  ] as const) {
    const error = await rejection(h.sessions.continueSession(sid, { by: "ngocbh" }))
    expect(error).toBeInstanceOf(HarnessError)
    expect([error.status, error.code, error.message]).toEqual([422, "not_continuable", why])
  }
})

test("a refusal from the codex sessions passes through", async () => {
  const h = makeCodex()
  h.fake.script([fc.agentMessage("m1", "First")])
  const old = await ended(h, h.workspace)
  spyOn(h.sessions, "start").mockRejectedValue(new HarnessError(409, "busy", "not now"))
  const error = await rejection(h.sessions.continueSession(old, { by: "ngocbh" }))
  expect(error).toBeInstanceOf(HarnessError)
  expect([error.status, error.code, error.message]).toEqual([409, "busy", "not now"])
  const fresh = h.store.listSessions().find((s) => s.parent_session_id === old)!
  expect(fresh.status).toBe("failed")
})

test("a resume codex refuses fails the new row and leaves the old one", async () => {
  const h = makeCodex()
  h.fake.script([fc.agentMessage("m1", "First")])
  const old = await ended(h, h.workspace)
  const before = h.store.getSession(old)
  h.fake.script([], { resume_error: { code: -32600, message: "no rollout found for thread thr_1" } })
  const fresh = await h.sessions.continueSession(old, { by: "ngocbh" })
  await waitFor(() => status(h, fresh.id) === "failed", { what: "the failed resume" })
  expect(errors(h, fresh.id)).toEqual(["Codex refused to load the thread: no rollout found for thread thr_1"])
  expect(h.store.getSession(old)).toEqual(before)
})

test("a session ended before an office restart continues after it", async () => {
  const h = makeCodex()
  h.fake.script([fc.agentMessage("m1", "First"), fc.agentMessage("m2", "Second")])
  const old = await ended(h, h.workspace)
  const r = await restarted(h)
  const fresh = await r.sessions.continueSession(old, { by: "ngocbh" })
  await waitFor(() => status(r, fresh.id) === "idle", { what: "the resume" })
  expect((h.fake.calls("thread/resume")[0] as { threadId: string }).threadId).toBe("thr_1")
  await r.sessions.prompt(fresh.id, "two")
  await waitFor(() => texts(r, fresh.id).join() === "Second", { what: "the second stretch" })
  expect(texts(r, fresh.id)).toEqual(["Second"])
})

test("two continuations at once make one new row and one 409 live", async () => {
  const h = makeCodex()
  h.fake.script([fc.agentMessage("m1", "First")])
  const old = await ended(h, h.workspace)
  const results = await Promise.allSettled([
    h.sessions.continueSession(old, { by: "ngocbh" }),
    h.sessions.continueSession(old, { by: "ngocbh" }),
  ])
  const done = results.filter((r) => r.status === "fulfilled")
  const refused = results.filter((r) => r.status === "rejected").map((r) => r.reason as HarnessError)
  expect(done).toHaveLength(1)
  expect(refused.map((e) => [e.status, e.code])).toEqual([[409, "live"]])
  const fresh = h.store.listSessions().filter((s) => s.parent_session_id === old)
  expect(fresh).toHaveLength(1)
  await waitFor(() => status(h, fresh[0]!.id) === "idle", { what: "the resume" })
})

test("a continuation whose folder is now unsafe is refused before any write", async () => {
  const h = makeCodex()
  const old = h.store.createSession(
    session({
      harness: "codex",
      status: "ended",
      harness_session_id: "thr_1",
      cwd: realPath(h.office.paths.company),
      repo_commit: await h.office.git.head(),
      opened_by: "ngocbh",
    }),
  )
  const error = await rejection(h.sessions.continueSession(old.id, { by: "ngocbh" }))
  expect(error).toBeInstanceOf(HarnessError)
  expect([error.status, error.code]).toEqual([422, "unsafe_workspace"])
  expect(h.store.listSessions().map((s) => s.id)).toEqual([old.id])
  expect(h.store.listWorkItems()).toEqual([])
})

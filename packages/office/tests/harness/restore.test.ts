/** After an office restart: idle stays idle, busy becomes idle and interrupted, starting fails, cards go stale. */
import { afterAll, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import * as fc from "../../src/testing/fake_codex.ts"
import { waitFor } from "../helpers.ts"
import {
  allGone,
  deltas,
  errors,
  fold,
  makeCodex,
  messages,
  reopened,
  restarted,
  start,
  status,
  texts,
} from "./helpers.ts"

setDefaultTimeout(30_000)
afterAll(allGone)

test("an idle session stays idle and reloads on its next message", async () => {
  const h = makeCodex()
  h.fake.script([
    [fc.commandApproval(1, "c1", "x", { wait: false }), { end: "completed" }],
    fc.agentMessage("m1", "Resumed"),
  ])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "go")
  await waitFor(() => h.store.listQuestions({ sessionId: sid }).length > 0 && status(h, sid) === "idle", {
    what: "the turn's end",
  })
  const r = await restarted(h)
  expect(status(r, sid)).toBe("idle")
  expect(r.store.listWorkers()).toEqual([])
  expect(await r.sessions.prompt(sid, "hello")).toBe("queued")
  await waitFor(() => texts(r, sid).includes("Resumed"), { what: "the reloaded reply" })
  expect((r.fake.calls("thread/resume")[0] as { threadId: string }).threadId).toBe("thr_1")
  expect(r.store.listWorkers().map((w) => w.key)).toEqual([`harness:${sid}`])
})

test("a busy session becomes idle with a marker and its cards go stale", async () => {
  const h = makeCodex()
  h.fake.script([[fc.commandStarted("c1", "sleep 60"), fc.commandApproval(1, "c1", "sleep 60")]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "go")
  await waitFor(() => h.store.listQuestions({ sessionId: sid, status: "open" }).length > 0, { what: "the card" })
  const r = await restarted(h)
  expect(status(r, sid)).toBe("idle")
  expect(r.store.listQuestions({ sessionId: sid }).map((q) => q.status)).toEqual(["stale"])
  // The tool part is the old office's stop's; the marker is the restored session's.
  const parts = messages(r, sid).flatMap((m) => m.parts)
  expect(parts.some((p) => p.type === "tool" && p.state === "interrupted")).toBe(true)
  const last = parts.at(-1)!
  expect(last.type === "text" && last.text.endsWith("[interrupted]")).toBe(true)
  expect(parts.filter((p) => p.type === "text" && p.text.endsWith("[interrupted]")).length).toBe(1)
  expect(r.sessions.currentTurn(sid).flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))))
    .toEqual(["[interrupted]"])
})

test("a session an office crash left busy gets its tools and turn marked", async () => {
  const h = makeCodex()
  h.fake.script([[fc.commandStarted("c1", "sleep 60"), { sleep: 30 }]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "go")
  await waitFor(() => messages(h, sid).some((m) => m.parts.some((p) => p.type === "tool")), { what: "the command" })
  // A crashed office emits nothing at its stop: kill the app-server and drop the session as a crash would.
  const live = h.sessions.get(sid)!
  live.stopped = true
  const p = live.process!
  live.process = null
  await p.kill()
  const n = h.events.length
  const r = reopened(h)
  await r.sessions.restore()
  const after = fold(h.events.slice(n).filter((e) => e.session_id === sid))
  expect(after.map((m) => [m.role, m.parts.flatMap((x) => (x.type === "text" ? [x.text] : []))])).toEqual([
    ["assistant", ["[interrupted]"]],
  ])
  expect(status(r, sid)).toBe("idle")
})

test("a session still starting fails", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace)
  h.store.updateSession(sid, { status: "starting" })
  const r = await restarted(h)
  expect(status(r, sid)).toBe("failed")
  expect(errors(r, sid)[0]).toContain("restarted before Codex started")
  expect(r.sessions.get(sid)).toBeUndefined()
})

test("a session ending when the office stopped ends", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace)
  h.store.updateSession(sid, { status: "ending" })
  const ended: string[] = []
  const r = reopened(h)
  r.hooks.sessionEnded.push((s) => void ended.push(s.status))
  await h.sessions.closeAll()
  await r.sessions.restore()
  expect(status(r, sid)).toBe("ended")
  expect(ended).toEqual(["ended"])
  expect(r.sessions.get(sid)).toBeUndefined()
  expect(r.store.getWorkItem(r.store.getSession(sid)!.work_item_id!)!.status).toBe("done")
})

test("a session that cant be restored leaves the others restored", async () => {
  const h = makeCodex()
  const first = await start(h, h.workspace)
  const second = await start(h, h.workspace)
  await h.sessions.closeAll()
  const r = reopened(h)
  const opener = r.sessions.opener.bind(r.sessions)
  spyOn(r.sessions, "opener").mockImplementation(async (s) => {
    if (s.id === first) throw new Error("sentinel")
    return opener(s)
  })
  await r.sessions.restore()
  expect(r.sessions.get(second)).toBeDefined()
  expect(r.sessions.get(first)).toBeUndefined()
  expect(r.lines).toContain(`can't restore Codex session ${first} (Error)`)
  expect(r.lines.some((line) => line.includes("sentinel"))).toBe(false)
})

test("office stop mid reply keeps all its text and marks it once", async () => {
  const h = makeCodex()
  h.fake.script([
    [
      fc.agentMessage("m1", "Hello there, friend")[0],
      fc.agentMessageDelta("m1", "Hello "),
      fc.agentMessageDelta("m1", "there, "),
      fc.agentMessageDelta("m1", "friend"),
      { sleep: 30 },
    ],
  ])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "go", { by: "ngocbh" })
  // The first chunk comes as a part.updated, so the deltas are the other two.
  await waitFor(() => deltas(h).at(-1) === "friend", { what: "the third delta" })
  await h.sessions.closeAll()
  const n = h.events.length
  const r = reopened(h)
  await r.sessions.restore()
  const got = fold(h.events.slice(0, n).filter((e) => e.session_id === sid)).map((m) => [
    m.role,
    m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])),
  ])
  expect(got).toEqual([
    ["user", ["go"]],
    ["assistant", ["Hello there, friend\n\n[interrupted]"]],
  ])
  expect(r.sessions.currentTurn(sid).flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))))
    .toEqual(["[interrupted]"])
  expect(status(r, sid)).toBe("idle")
})

test("a restored session whose first reload fails says why and stays idle", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace)
  h.fake.script([], { resume_error: { code: -32600, message: "no rollout found" } })
  const r = await restarted(h)
  expect(await r.sessions.prompt(sid, "hello")).toBe("queued")
  await waitFor(() => errors(r, sid).length > 0, { what: "the refused reload" })
  expect(status(r, sid)).toBe("idle")
  expect(r.sessions.get(sid)!.timer).toBeNull()
})

test("a restore after office stop restores nothing", async () => {
  const h = makeCodex()
  h.fake.script([[fc.commandStarted("c1", "sleep 60"), fc.commandApproval(1, "c1", "sleep 60")]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "go")
  await waitFor(() => h.store.listQuestions({ sessionId: sid, status: "open" }).length > 0, { what: "the card" })
  await h.sessions.closeAll()
  const r = reopened(h)
  await r.sessions.closeAll()
  await r.sessions.restore()
  expect(r.sessions.get(sid)).toBeUndefined()
  expect(status(r, sid)).toBe("waiting")
  expect(r.store.listQuestions({ sessionId: sid }).map((q) => q.status)).toEqual(["open"])
})

test("restoring an idle session leaves its row alone", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace)
  await h.sessions.closeAll()
  const before = h.store.getSession(sid)
  const r = reopened(h)
  await r.sessions.restore()
  // Its updated_at too: a restart doesn't re-sort the sessions.
  expect(r.store.getSession(sid)).toEqual(before)
})

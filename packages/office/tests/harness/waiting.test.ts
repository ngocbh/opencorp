/** The run state Codex sessions write, and how a restart finds a waiting one. */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import * as fc from "../../src/testing/fake_codex.ts"
import { waitFor } from "../helpers.ts"
import { type Codex, allGone, approvalTurn, makeCodex, openCard, restarted, start, status, texts } from "./helpers.ts"

setDefaultTimeout(30_000)
afterAll(allGone)

/** The session's status and whom it waits on. */
function state(h: Codex, sid: string): [string | undefined, string[] | undefined] {
  const s = h.store.getSession(sid)
  return [s?.status, s?.waiting_on]
}

/** The statuses the session was written with, in order, without repeats. */
function statuses(h: Codex, sid: string): string[] {
  const seen = h.storeEvents
    .filter((e) => e.type === "session.updated" && e.subject_id === sid)
    .map((e) => (e.data as { status: string }).status)
  return seen.filter((x, n) => n === 0 || seen[n - 1] !== x)
}

test("an approval inside a turn is waiting then busy after the reply", async () => {
  const h = makeCodex()
  h.fake.script([approvalTurn()])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "make a")
  const q = await openCard(h, sid)
  await waitFor(() => Bun.deepEquals(state(h, sid), ["waiting", ["ngocbh"]]), { what: "waiting on the opener" })
  await h.sessions.answer(q.id, "Approve", "option", { by: "ngocbh" })
  await waitFor(() => Bun.deepEquals(state(h, sid), ["idle", []]), { what: "the turn's end" })
  expect(statuses(h, sid).slice(-3)).toEqual(["waiting", "busy", "idle"])
})

test("a turnless card is waiting with no turn then idle once answered", async () => {
  const h = makeCodex()
  h.fake.script([[fc.urlElicitation(8, "gh", "Sign in", "https://e.com/l", { wait: false })]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "sign in")
  const q = await openCard(h, sid)
  await waitFor(() => Bun.deepEquals(state(h, sid), ["waiting", ["ngocbh"]]) && h.sessions.get(sid)!.turnId === null, {
    what: "waiting after the turn",
  })
  await h.sessions.answer(q.id, "Done", "option", { by: "ngocbh" })
  await waitFor(() => Bun.deepEquals(state(h, sid), ["idle", []]), { what: "idle, not busy" })
})

test("a card codex resolves itself leaves waiting", async () => {
  const h = makeCodex()
  h.fake.script([
    [fc.commandApproval(1, "c1", "touch a", { wait: false }), { sleep: 0.3 }, { resolve: 1 }, { sleep: 5 }],
  ])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "make a")
  await openCard(h, sid)
  await waitFor(() => status(h, sid) === "waiting", { what: "waiting" })
  await waitFor(() => Bun.deepEquals(state(h, sid), ["busy", []]), {
    what: "busy again once Codex resolved it",
  })
})

test("a waiting session with a turn card restores idle with the marker", async () => {
  const h = makeCodex()
  h.fake.script([[fc.commandStarted("c1", "sleep 60"), fc.commandApproval(1, "c1", "sleep 60")]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "go")
  await waitFor(() => status(h, sid) === "waiting", { what: "the card" })
  const r = await restarted(h)
  expect(state(r, sid)).toEqual(["idle", []])
  expect(texts(r, sid).at(-1)!.endsWith("[interrupted]")).toBe(true)
  expect(r.store.listQuestions({ sessionId: sid }).map((q) => q.status)).toEqual(["stale"])
})

test("a session waiting only on turnless cards restores idle without the marker", async () => {
  const h = makeCodex()
  h.fake.script([[fc.urlElicitation(8, "gh", "Sign in", "https://e.com/l", { wait: false })]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "sign in")
  await waitFor(() => status(h, sid) === "waiting" && h.sessions.get(sid)!.turnId === null, { what: "waiting" })
  const r = await restarted(h)
  expect(state(r, sid)).toEqual(["idle", []])
  expect(texts(r, sid).some((t) => t.endsWith("[interrupted]"))).toBe(false)
})

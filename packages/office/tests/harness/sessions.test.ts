/** The office's Codex sessions: what `CodexSessions` keeps beyond one session's app-server and turns. */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import * as fc from "../../src/testing/fake_codex.ts"
import { waitFor } from "../helpers.ts"
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

import { expect, test } from "bun:test"
import type { Event, LiveEvent, Message, Session } from "@opencorp/protocol"
import { applyLive, applyMeta, emptyState, openQuestions, replay, sessionsIn } from "../../src/office/store"

const S = "S1"
const session = (over: Partial<Session> = {}): Session => ({
  id: S,
  person: "minh",
  harness: "composer",
  office: "laptop",
  cwd: "/tmp/proj",
  repo_commit: "c",
  status: "idle",
  kind: "main",
  created_at: "t0",
  updated_at: "t1",
  ...over,
})
const meta = (type: Event["type"], data: object, subject = (data as { id: string }).id): Event => ({
  id: "E",
  type,
  at: "t",
  subject_id: subject,
  data: data as Record<string, unknown>,
})
const text = (id: string, t: string) => ({ id, type: "text" as const, text: t })
const msg = (id: string, parts = [text("p1", "he")]): Message => ({
  id,
  session_id: S,
  role: "assistant",
  parts,
  created_at: "t",
})
const live = (type: LiveEvent["type"], data: object): LiveEvent => ({
  type,
  session_id: S,
  data: data as Record<string, unknown>,
})
const synced = () => {
  const s = emptyState()
  s.messages[S] = []
  return s
}
const texts = (m: Message) => m.parts.map((p) => (p as { text: string }).text)

test("session events upsert, newest-updated first, and never go back in time", () => {
  const s = emptyState()
  applyMeta(s, meta("session.created", session()))
  applyMeta(s, meta("session.created", session({ id: "S2", updated_at: "t2" })))
  expect(s.sessions.map((x) => x.id)).toEqual(["S2", S])
  applyMeta(s, meta("session.updated", session({ status: "busy", updated_at: "t3" })))
  applyMeta(s, meta("session.updated", session({ status: "idle", updated_at: "t2" }))) // stale
  expect(s.sessions[0]).toMatchObject({ id: S, status: "busy" })
})

test("each meta type lands in its slice; unknown types are ignored", () => {
  const s = emptyState()
  applyMeta(s, meta("question.created", { id: "Q", session_id: S, status: "open", created_at: "t", updated_at: "t" }))
  applyMeta(s, meta("profile.updated", { person: "minh", text: "x", version: "v" }, "minh"))
  applyMeta(s, meta("debrief.created", { session_id: S, state: "pending", updated_at: "t" }, S))
  applyMeta(s, meta("work_item.created", { id: "W", title: "w", updated_at: "t" }))
  applyMeta(s, meta("profile_proposal.created", { id: "P", person: "minh" }))
  applyMeta(s, meta("feedback.created", { id: "F", session_id: S }))
  const comment = { id: "C", work_item_id: "W", author: "minh", body: "b", created_at: "t" }
  applyMeta(s, meta("comment.created", comment))
  applyMeta(s, meta("comment.created", comment))
  applyMeta(s, { ...meta("session.created", session()), type: "person.hired" as Event["type"] })
  expect(openQuestions(s, S).map((q) => q.id)).toEqual(["Q"])
  expect([s.profiles.minh.version, s.debriefs[S].state, s.comments.W.length, s.sessions.length]).toEqual([
    "v",
    "pending",
    1,
    0,
  ])
  expect([s.workItems.W.title, s.proposals.P.person, s.feedback.F.session_id]).toEqual(["w", "minh", S])
})

test("openQuestions: only open ones for the session, oldest first; sessionsIn: main sessions in a folder", () => {
  const s = emptyState()
  const q = (id: string, over: object) =>
    applyMeta(
      s,
      meta("question.created", { id, session_id: S, status: "open", created_at: id, updated_at: id, ...over }),
    )
  q("Q2", {})
  q("Q1", {})
  q("Q3", { status: "answered" })
  q("Q4", { session_id: "S2" })
  expect(openQuestions(s, S).map((x) => x.id)).toEqual(["Q1", "Q2"])
  applyMeta(s, meta("session.created", session()))
  applyMeta(s, meta("session.created", session({ id: "S2", kind: "side" })))
  applyMeta(s, meta("session.created", session({ id: "S3", cwd: "/elsewhere" })))
  expect(sessionsIn(s, "/tmp/proj").map((x) => x.id)).toEqual([S])
})

test("message.updated merges parts by id and keeps parts the event lacks", () => {
  const s = synced()
  applyLive(s, live("message.updated", msg("M", [text("p1", "a"), text("p2", "b")])))
  applyLive(s, live("message.updated", msg("M", [text("p2", "B"), text("p3", "c")])))
  expect(texts(s.messages[S][0])).toEqual(["a", "B", "c"])
})

test("messages stay in id order; sessions not synced are skipped", () => {
  const s = synced()
  applyLive(s, live("message.updated", msg("M2")))
  applyLive(s, live("message.updated", msg("M1")))
  applyLive(s, { ...live("message.updated", msg("X")), session_id: "OTHER" })
  expect(s.messages[S].map((m) => m.id)).toEqual(["M1", "M2"])
  expect(s.messages.OTHER).toBeUndefined()
})

test("a delta before its part is ignored; after part.updated it appends", () => {
  const s = synced()
  applyLive(s, live("message.updated", msg("M", [])))
  applyLive(s, live("part.delta", { message_id: "M", part_id: "p1", text: "lo" }))
  expect(s.messages[S][0].parts).toEqual([])
  applyLive(s, live("part.updated", { message_id: "M", part: text("p1", "hel") }))
  applyLive(s, live("part.delta", { message_id: "M", part_id: "p1", text: "lo" }))
  expect(s.messages[S][0].parts).toEqual([text("p1", "hello")])
})

test("part.updated for an unknown message creates it; deltas to non-text parts are ignored", () => {
  const s = synced()
  const tool = { id: "t1", type: "tool", call_id: "c", tool: "shell", state: "running", input: { command: "ls" } }
  applyLive(s, live("part.updated", { message_id: "M", part: tool }))
  applyLive(s, live("part.delta", { message_id: "M", part_id: "t1", text: "x" }))
  expect(s.messages[S][0]).toMatchObject({ id: "M", role: "assistant", parts: [tool] })
})

test("malformed live data is skipped", () => {
  const s = synced()
  applyLive(s, live("message.updated", { id: "M" }))
  applyLive(s, live("part.updated", { message_id: "M", part: "nope" }))
  applyLive(s, live("part.delta", { message_id: "M", part_id: 3, text: "x" }))
  expect(s.messages[S]).toEqual([])
})

test("malformed meta data is skipped", () => {
  const s = emptyState()
  applyMeta(s, meta("session.updated", { id: 3 }, "S1"))
  applyMeta(s, meta("session.created", { ...session(), updated_at: undefined }))
  applyMeta(s, meta("question.created", { id: "Q" }))
  applyMeta(s, meta("work_item.updated", { title: "x" }, "W"))
  applyMeta(s, meta("debrief.created", { id: "D" }))
  applyMeta(s, meta("comment.created", { id: "C" }))
  applyMeta(s, { ...meta("profile_proposal.created", {}, "P"), data: "nope" as never })
  applyMeta(s, { ...meta("profile.updated", {}), subject_id: undefined as never })
  applyMeta(s, { ...meta("session.updated", session()), type: undefined as never })
  expect(s).toEqual(emptyState())
})

test("replay: a buffered delta for a snapshot part is dropped, not doubled", () => {
  const s = synced()
  s.messages[S] = [msg("M", [text("p1", "hello")])] // the snapshot already has "lo"
  replay(s, [{ type: "live", event: live("part.delta", { message_id: "M", part_id: "p1", text: "lo" }) }])
  expect(s.messages[S][0].parts).toEqual([text("p1", "hello")])
})

test("replay: deltas after a buffered full part apply; meta events apply", () => {
  const s = synced()
  s.messages[S] = [msg("M", [text("p1", "he")])]
  replay(s, [
    { type: "live", event: live("part.delta", { message_id: "M", part_id: "p1", text: "l" }) },
    { type: "live", event: live("part.updated", { message_id: "M", part: text("p1", "hel") }) },
    { type: "live", event: live("part.delta", { message_id: "M", part_id: "p1", text: "lo" }) },
    { type: "meta", id: "E", event: meta("session.updated", session({ status: "busy", updated_at: "t9" })) },
  ])
  expect(s.messages[S][0].parts).toEqual([text("p1", "hello")])
  expect(s.sessions[0].status).toBe("busy")
})

import { expect, test } from "bun:test"
import type { Event, Instrument, LiveEvent, Message, Question, Session } from "@opencorp/protocol"
import type { OfficeClient } from "../src/client"
import { OfficeError } from "../src/errors"
import type { StreamEvent } from "../src/sse"
import { applyLive, applyMeta, emptyState, openQuestions, replay, sessionsIn } from "../src/store"
import { createOfficeSync, type OfficeStatus } from "../src/sync"

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
  applyMeta(s, meta("work_item.created", { id: "W", title: "w", updated_at: "t" }))
  applyMeta(s, meta("profile_proposal.created", { id: "P", person: "minh" }))
  const comment = { id: "C", work_item_id: "W", author: "minh", body: "b", created_at: "t" }
  applyMeta(s, meta("comment.created", comment))
  applyMeta(s, meta("comment.created", comment))
  applyMeta(s, { ...meta("session.created", session()), type: "person.hired" as Event["type"] })
  expect(openQuestions(s, S).map((q) => q.id)).toEqual(["Q"])
  expect([s.profiles.minh.version, s.comments.W.length, s.sessions.length]).toEqual(["v", 1, 0])
  expect([s.workItems.W.title, s.proposals.P.person]).toEqual(["w", "minh"])
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

const instrument = (id: string, over: Partial<Instrument> = {}): Instrument => ({
  id,
  session_id: S,
  kind: "terminal",
  name: "shell 1",
  driver: "minh",
  profile: "workspace",
  interactive: true,
  size: { cols: 80, rows: 24 },
  status: "running",
  command: "make",
  created_at: "t0",
  updated_at: "t1",
  ...over,
})

test("instrument.updated adds or replaces a session's instrument", () => {
  const s = synced()
  applyLive(s, live("instrument.updated", instrument("I2", { name: "shell 2" })))
  applyLive(s, live("instrument.updated", instrument("I1")))
  expect(s.instruments[S].map((i) => i.id)).toEqual(["I1", "I2"])
  applyLive(s, live("instrument.updated", instrument("I1", { status: "waiting", waiting: "secret", updated_at: "t3" })))
  applyLive(s, live("instrument.updated", instrument("I1", { status: "idle", updated_at: "t2" }))) // stale
  expect(s.instruments[S].map((i) => [i.id, i.status, i.waiting])).toEqual([
    ["I1", "waiting", "secret"],
    ["I2", "running", undefined],
  ])
  // A session not synced, an instrument of another session, and malformed data are skipped.
  applyLive(s, { ...live("instrument.updated", instrument("X", { session_id: "OTHER" })), session_id: "OTHER" })
  applyLive(s, live("instrument.updated", instrument("Y", { session_id: "OTHER" })))
  applyLive(s, live("instrument.updated", { id: "Z", session_id: S }))
  expect(s.instruments.OTHER).toBeUndefined()
  expect(s.instruments[S].map((i) => i.id)).toEqual(["I1", "I2"])
  expect(s.messages[S]).toEqual([])
})

test("instrument.removed drops a session's instrument", () => {
  const s = synced()
  applyLive(s, live("instrument.updated", instrument("I1")))
  applyLive(s, live("instrument.updated", instrument("I2", { name: "shell 2" })))
  applyLive(s, live("instrument.removed", { id: "I1", session_id: S }))
  expect(s.instruments[S].map((i) => i.id)).toEqual(["I2"])
  // One it doesn't have, one named for another session, and malformed data change nothing.
  applyLive(s, live("instrument.removed", { id: "I9", session_id: S }))
  applyLive(s, live("instrument.removed", { id: "I2", session_id: "OTHER" }))
  applyLive(s, live("instrument.removed", { id: 2, session_id: S }))
  applyLive(s, { ...live("instrument.removed", { id: "I2", session_id: "OTHER" }), session_id: "OTHER" })
  expect(s.instruments[S].map((i) => i.id)).toEqual(["I2"])
  expect(s.instruments.OTHER).toBeUndefined()
})

test("message.removed drops a session's message", () => {
  const s = synced()
  for (const id of ["M1", "M2"]) {
    const message = { id, session_id: S, role: "user", author: null, created_at: "t", parts: [] }
    applyLive(s, live("message.updated", message))
  }
  applyLive(s, live("message.removed", { id: "M1", session_id: S }))
  expect(s.messages[S].map((m) => m.id)).toEqual(["M2"])
  // One it doesn't have, one named for another session, and malformed data change nothing.
  applyLive(s, live("message.removed", { id: "M9", session_id: S }))
  applyLive(s, live("message.removed", { id: "M2", session_id: "OTHER" }))
  applyLive(s, live("message.removed", { id: 2, session_id: S }))
  expect(s.messages[S].map((m) => m.id)).toEqual(["M2"])
})

test("an instrument of a kind the client doesn't know isn't kept", () => {
  const s = synced()
  applyLive(s, live("instrument.updated", instrument("I1", { kind: "browser" as Instrument["kind"] })))
  expect(s.instruments[S]).toBeUndefined()
  applyLive(s, live("instrument.updated", instrument("I2", { kind: "claude" })))
  expect(s.instruments[S].map((i) => [i.id, i.kind])).toEqual([["I2", "claude"]])
})

/**
 * A sync on a client that answers only what `routes` holds, keyed `<method> <path>`, and whose event stream the test
 * drives with `send`; `clean` upper-cases, so what it touched shows.
 */
function stubSync(routes: Record<string, () => unknown> = {}) {
  const state = emptyState()
  let handler: ((e: StreamEvent) => void) | undefined
  const answer = (key: string) => async () => {
    const route = routes[key]
    if (!route) throw new OfficeError(404, "no_route", `no route ${key}`)
    return route()
  }
  const client = {
    events: {
      subscribe: (h: (e: StreamEvent) => void) => {
        handler = h
        return { close() {}, reconnect() {} }
      },
    },
    sessions: {
      get: (id: string) => answer(`GET /sessions/${id}`)(),
      messages: (id: string) => answer(`GET /sessions/${id}/messages`)(),
      instruments: (id: string) => answer(`GET /sessions/${id}/instruments`)(),
    },
    questions: { list: (opts: { session: string }) => answer(`GET /questions?session=${opts.session}`)() },
  } as unknown as OfficeClient
  const statuses: OfficeStatus[] = []
  const sync = createOfficeSync({
    client,
    snapshot: async () => () => {},
    state: () => state,
    mutate: (fn) => fn(state),
    onStatus: (status) => statuses.push(status),
    clean: (text) => text.toUpperCase(),
  })
  sync.start()
  handler!({ type: "connected" })
  return {
    state,
    sync,
    send: (e: StreamEvent) => handler!(e),
    online: async () => {
      while (!statuses.includes("online")) await new Promise((resolve) => setTimeout(resolve, 1))
    },
  }
}

test("instrument.output is handed to listeners, not kept in the store", async () => {
  const { state, sync, send, online } = stubSync()
  await online()
  const got: LiveEvent[] = []
  sync.on("instrument.output", (e) => got.push(e))
  // Raw terminal bytes, base64: the screen as it is, which nothing cleans.
  const output = live("instrument.output", { instrument_id: "I1", offset: 0, data: "G1szMW1vaxtbMG0NCg==" })
  const before = structuredClone(state)
  send({ type: "live", event: output })
  send({ type: "live", event: { ...output, session_id: "OTHER" } })
  expect(got.map((e) => [e.session_id, e.data])).toEqual([
    [S, output.data],
    ["OTHER", output.data],
  ])
  expect(state).toEqual(before)
  const s = synced()
  applyLive(s, output)
  expect(s).toEqual(synced())
  sync.stop()
})

test("an instrument's note is cleaned as a message is, its instrument's name too; its id stays as sent", async () => {
  const note: Message = {
    id: "N1",
    session_id: S,
    role: "user",
    author: null,
    instrument: { id: "01JA1X0000000000000000000A", name: "shell 1" },
    parts: [{ id: "n1", type: "text", text: "shell 1: `make` ended, exit 2" }],
    created_at: "t",
  }
  const routes: Record<string, () => unknown> = {
    [`GET /sessions/${S}`]: () => session(),
    [`GET /sessions/${S}/messages`]: () => [note],
    [`GET /questions?session=${S}`]: () => [] as Question[],
    [`GET /sessions/${S}/instruments`]: () => [],
  }
  const { state, sync, send, online } = stubSync(routes)
  await online()
  await sync.syncSession(S)
  const cleaned = { ...note, instrument: { id: "01JA1X0000000000000000000A", name: "SHELL 1" } }
  expect(state.messages[S]).toEqual([{ ...cleaned, parts: [{ id: "n1", type: "text", text: "SHELL 1: `MAKE` ENDED, EXIT 2" }] }])
  send({ type: "live", event: live("message.updated", { ...note, id: "N2" }) })
  expect(state.messages[S]![1]!.instrument).toEqual({ id: "01JA1X0000000000000000000A", name: "SHELL 1" })
  sync.stop()
})

test("a synced session's instruments are read with its messages, and an office that serves none has none", async () => {
  const listed = [
    instrument("I1", { command: "make", error: "no tty" }),
    instrument("I3", { kind: "browser" as Instrument["kind"] }),
  ]
  const routes: Record<string, () => unknown> = {
    [`GET /sessions/${S}`]: () => session(),
    [`GET /sessions/${S}/messages`]: () => [],
    [`GET /questions?session=${S}`]: () => [] as Question[],
    [`GET /sessions/${S}/instruments`]: () => listed,
    "GET /sessions/S2": () => session({ id: "S2" }),
    "GET /sessions/S2/messages": () => [],
    "GET /questions?session=S2": () => [],
  }
  const { state, sync, send, online } = stubSync(routes)
  await online()
  await sync.syncSession(S)
  // What it shows is cleaned as names and messages are; ids, states and the driver stay as sent. A kind the client
  // doesn't know is left out.
  expect(state.instruments[S]).toEqual([{ ...listed[0], name: "SHELL 1", command: "MAKE", error: "NO TTY" }])
  send({ type: "live", event: live("instrument.updated", instrument("I2", { command: "ls -la", updated_at: "t2" })) })
  expect(state.instruments[S].map((i) => [i.id, i.command])).toEqual([["I1", "MAKE"], ["I2", "LS -LA"]])
  await sync.syncSession("S2")
  expect(state.instruments.S2).toEqual([])
  sync.stop()
})

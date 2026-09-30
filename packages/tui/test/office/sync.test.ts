import { afterEach, expect, test } from "bun:test"
import type { Message } from "@agent-corp/protocol"
import { createFakeOffice, type FakeOffice } from "../../script/stub"
import { createOfficeClient } from "../../src/office/client"
import { emptyState, openQuestions } from "../../src/office/store"
import { createOfficeSync } from "../../src/office/sync"
import { until } from "../fixture/until"

const fast = { minDelayMs: 10, maxDelayMs: 40 }
let office: FakeOffice | undefined
let stop = () => {}
afterEach(() => {
  stop()
  office?.stop()
  office = undefined
})
function start(socket: string, stream = fast, maxBuffered?: number) {
  const state = emptyState()
  const sync = createOfficeSync({
    client: createOfficeClient({ socket }),
    cwd: "/tmp/proj",
    state: () => state,
    mutate: (f) => f(state),
    stream,
    maxBuffered,
  })
  sync.start()
  stop = sync.stop
  return { state, sync }
}
const count = (o: FakeOffice, what: string) => o.requests.filter((r) => `${r.method} ${r.path}` === what).length

test("bootstrap: people, folder people, and sessions; then online", async () => {
  office = createFakeOffice()
  const { state, sync } = start(office.socket)
  await until(() => sync.status() === "online")
  expect(state.people.map((p) => p.handle)).toEqual(["minh", "ngocbh"])
  expect(state.folderPeople.map((p) => p.handle)).toEqual(["minh"])
  expect(state.sessions).toHaveLength(1)
})

test("events that arrive during the bootstrap are applied on top of the snapshot", async () => {
  office = createFakeOffice()
  const release = office.hold("GET /sessions")
  const { state, sync } = start(office.socket)
  await until(() => count(office!, "GET /sessions?limit=50") === 1)
  const s = office.state.sessions[0]
  office.emit({
    id: "E1",
    type: "session.updated",
    at: "t",
    subject_id: s.id,
    data: { ...s, status: "busy", updated_at: "2099-01-01T00:00:00Z" },
  })
  await Bun.sleep(30)
  expect(state.sessions).toHaveLength(0) // buffered, not applied yet
  release() // the snapshot still says idle
  await until(() => sync.status() === "online")
  expect(state.sessions[0].status).toBe("busy")
})

test("syncSession buffers that session's live events and replays them", async () => {
  office = createFakeOffice()
  const { state, sync } = start(office.socket)
  await until(() => sync.status() === "online")
  const id = office.state.sessions[0].id
  office.state.messages[id] = [
    { id: "M", session_id: id, role: "assistant", parts: [{ id: "p1", type: "text", text: "hello" }], created_at: "t" },
  ]
  const release = office.hold("GET /sessions/:id/messages")
  const done = sync.syncSession(id)
  await until(() => count(office!, `GET /sessions/${id}/messages`) === 1)
  office.live({ type: "part.delta", session_id: id, data: { message_id: "M", part_id: "p1", text: "lo" } }) // already in the snapshot
  office.live({
    type: "part.updated",
    session_id: id,
    data: { message_id: "M", part: { id: "p2", type: "text", text: "wor" } },
  })
  office.live({ type: "part.delta", session_id: id, data: { message_id: "M", part_id: "p2", text: "ld" } })
  await Bun.sleep(30)
  release()
  await done
  expect(state.messages[id][0].parts.map((p) => (p as { text: string }).text)).toEqual(["hello", "world"])
  office.live({ type: "part.delta", session_id: id, data: { message_id: "M", part_id: "p2", text: "!" } })
  await until(() => (state.messages[id][0].parts[1] as { text: string }).text === "world!")
})

test("syncSession loads the session's open questions", async () => {
  office = createFakeOffice()
  const { state, sync } = start(office.socket)
  await until(() => sync.status() === "online")
  const id = office.state.sessions[0].id
  office.state.questions.Q = { ...office.addQuestion({}), id: "Q" } // opened with no event seen for "Q"
  await sync.syncSession(id)
  expect(openQuestions(state, id).map((q) => q.id)).toContain("Q")
})

test("reset re-runs the bootstrap and picks up changes it missed", async () => {
  office = createFakeOffice()
  const { state, sync } = start(office.socket)
  await until(() => sync.status() === "online")
  const id = office.state.sessions[0].id
  await sync.syncSession(id)
  office.state.sessions.unshift({ ...office.state.sessions[0], id: "S-NEW", updated_at: "2099-01-01T00:00:00Z" }) // no event
  office.state.messages[id].push({ id: "M9", session_id: id, role: "user", parts: [], created_at: "t" })
  office.reset()
  await until(() => count(office!, "GET /sessions?limit=50") === 2)
  await until(() => state.sessions[0]?.id === "S-NEW" && state.messages[id].some((m) => m.id === "M9"))
})

test("after a reconnect, questions opened and answered while away are current", async () => {
  office = createFakeOffice()
  const { state, sync } = start(office.socket)
  await until(() => sync.status() === "online")
  const id = office.state.sessions[0].id
  await sync.syncSession(id)
  const seen = office.addQuestion({})
  await until(() => openQuestions(state, id).length === 1)
  office.dropStreams()
  await until(() => sync.status() === "connecting")
  // While the stream is down: one question is answered, another opens; neither event reaches us.
  office.state.questions[seen.id] = { ...seen, status: "answered" }
  const missed = office.addQuestion({})
  await until(() => sync.status() === "online")
  await until(
    () =>
      openQuestions(state, id)
        .map((q) => q.id)
        .join() === missed.id,
  )
})

test("an office without the open-questions route still comes online", async () => {
  office = createFakeOffice({ notImplemented: ["GET /questions"] })
  const { sync } = start(office.socket)
  await until(() => sync.status() === "online")
  await sync.syncSession(office.state.sessions[0].id)
})

test("offline without a socket, online once the office starts, offline when it stops", async () => {
  const socket = `/tmp/act-sync-${process.pid}.sock`
  const { sync } = start(socket)
  await until(() => sync.status() === "offline")
  office = createFakeOffice({ socket })
  await until(() => sync.status() === "online")
  office.stop()
  office = undefined
  await until(() => sync.status() === "offline")
})

test("a failed bootstrap reconnects and tries again", async () => {
  office = createFakeOffice({ notImplemented: ["GET /people"] })
  const { sync } = start(office.socket)
  await until(() => count(office!, "GET /people") >= 1)
  expect(sync.status()).not.toBe("online")
  office.notImplemented.clear()
  await until(() => sync.status() === "online")
})

test("refreshPeople re-reads both people lists", async () => {
  office = createFakeOffice()
  const { state, sync } = start(office.socket)
  await until(() => sync.status() === "online")
  office.state.people.push({ ...office.state.people[0], id: "lan", handle: "lan" })
  await sync.refreshPeople()
  expect(state.people.map((p) => p.handle)).toContain("lan")
})

test("on() sees applied events", async () => {
  office = createFakeOffice()
  const { sync } = start(office.socket)
  await until(() => sync.status() === "online")
  const seen: string[] = []
  const off = sync.on("question.created", (e) => seen.push(e.subject_id))
  const q = office.addQuestion({})
  await until(() => seen.includes(q.id))
  off()
  office.addQuestion({})
  await Bun.sleep(30)
  expect(seen).toEqual([q.id])
})

test("refreshQuestion re-reads a question the stream never updated", async () => {
  office = createFakeOffice()
  const s = office.state.sessions[0]
  const { state, sync } = start(office.socket)
  await until(() => sync.status() === "online")
  const q = office.addQuestion({ session_id: s.id })
  await until(() => openQuestions(state, s.id).length === 1)
  office.state.questions[q.id] = { ...q, status: "answered" }
  await sync.refreshQuestion(q.id)
  expect(openQuestions(state, s.id)).toEqual([])
  delete office.state.questions[q.id]
  await sync.refreshQuestion(q.id)
  expect(state.questions[q.id]).toBeUndefined()
})

test("a bootstrap that keeps failing retries at a bounded rate and shows the error", async () => {
  office = createFakeOffice({ notImplemented: ["GET /people"] })
  const { sync } = start(office.socket, { minDelayMs: 20, maxDelayMs: 80 })
  await until(() => sync.status() === "error")
  expect(sync.error()).toContain("not implemented")
  await Bun.sleep(600)
  // Retrying every 20 ms would be about 30; backing off to 80 ms keeps it near 9.
  expect(count(office, "GET /people")).toBeLessThan(15)
  expect(sync.status()).toBe("error") // reconnecting doesn't hide it
  office.notImplemented.clear()
  await until(() => sync.status() === "online", 3000)
  expect(sync.error()).toBeUndefined()
})

test("folder people failing leaves the list empty and still comes online", async () => {
  office = createFakeOffice({ notImplemented: ["GET /folders/:cwd/people"] })
  const logged: unknown[] = []
  const error = console.error
  console.error = (...args: unknown[]) => void logged.push(args)
  try {
    const { state, sync } = start(office.socket)
    await until(() => sync.status() === "online")
    expect(state.people).toHaveLength(2)
    expect(state.folderPeople).toEqual([])
    expect(logged).toHaveLength(1)
  } finally {
    console.error = error
  }
})

const textMessage = (sessionId: string, id: string): Message => ({
  id,
  session_id: sessionId,
  role: "assistant",
  parts: [{ id: `${id}-p`, type: "text", text: id }],
  created_at: "t",
})

test("a session load that spans a reconnect still ends up with what happened in the gap", async () => {
  office = createFakeOffice()
  const { state, sync } = start(office.socket)
  await until(() => sync.status() === "online")
  const id = office.state.sessions[0].id
  const messages = `GET /sessions/${id}/messages`
  office.state.messages[id] = [textMessage(id, "M1")]
  const release = office.hold("GET /sessions/:id/messages", "reply")
  const done = sync.syncSession(id)
  await until(() => count(office!, messages) === 1) // its reply is read already: M1 only
  office.dropStreams()
  await until(() => sync.status() !== "online")
  // While no stream is open, M2 lands; its event reaches no one.
  const m2 = textMessage(id, "M2")
  office.state.messages[id].push(m2)
  office.live({ type: "message.updated", session_id: id, data: structuredClone(m2) as never })
  await until(() => count(office!, messages) === 2) // the reconnect's bootstrap reloads it
  release()
  await done
  await until(() => sync.status() === "online")
  expect(state.messages[id].map((m) => m.id)).toEqual(["M1", "M2"])
})

test("a bootstrap whose stream ends before it finishes is dropped", async () => {
  office = createFakeOffice()
  const release = office.hold("GET /sessions")
  const { state, sync } = start(office.socket)
  await until(() => count(office!, "GET /sessions?limit=50") === 1)
  office.notImplemented.add("GET /events") // it can't reconnect
  office.dropStreams()
  await until(() => sync.status() === "offline")
  release()
  await Bun.sleep(50)
  expect(sync.status()).toBe("offline")
  expect(state.sessions).toEqual([])
})

test("loading a session twice at once sends one request", async () => {
  office = createFakeOffice()
  const { sync } = start(office.socket)
  await until(() => sync.status() === "online")
  const id = office.state.sessions[0].id
  await Promise.all([sync.syncSession(id), sync.syncSession(id)])
  expect(count(office, `GET /sessions/${id}/messages`)).toBe(1)
})

test("too many events during a bootstrap abandon it and reconnect", async () => {
  office = createFakeOffice()
  const release = office.hold("GET /sessions")
  const { sync } = start(office.socket, fast, 5)
  await until(() => count(office!, "GET /sessions?limit=50") === 1)
  const s = office.state.sessions[0]
  for (let i = 0; i < 10; i++)
    office.emit({ id: `E${i}`, type: "session.updated", at: "t", subject_id: s.id, data: { ...s } })
  await until(() => count(office!, "GET /events") === 2)
  release()
  await until(() => sync.status() === "online")
})

test("too many events while a session loads abandon the load's window and reconnect", async () => {
  office = createFakeOffice()
  const { state, sync } = start(office.socket, fast, 5)
  await until(() => sync.status() === "online")
  const id = office.state.sessions[0].id
  office.state.messages[id] = [textMessage(id, "M1")]
  const release = office.hold("GET /sessions/:id/messages")
  const done = sync.syncSession(id)
  await until(() => count(office!, `GET /sessions/${id}/messages`) === 1)
  for (let i = 0; i < 10; i++)
    office.live({ type: "part.delta", session_id: id, data: { message_id: "M1", part_id: "M1-p", text: "!" } })
  await until(() => count(office!, "GET /events") === 2)
  release()
  await done
  await until(() => sync.status() === "online")
  expect(state.messages[id].map((m) => m.id)).toEqual(["M1"])
})

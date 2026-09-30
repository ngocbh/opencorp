import { afterEach, expect, test } from "bun:test"
import { createFakeOffice, type FakeOffice } from "../../script/stub"
import { createOfficeClient } from "../../src/office/client"
import { emptyState, openQuestions } from "../../src/office/store"
import { createOfficeSync } from "../../src/office/sync"

const fast = { minDelayMs: 10, maxDelayMs: 40 }
let office: FakeOffice | undefined
let stop = () => {}
afterEach(() => {
  stop()
  office?.stop()
  office = undefined
})
async function until(cond: () => boolean, ms = 2000) {
  for (const end = Date.now() + ms; !cond(); await Bun.sleep(5)) if (Date.now() > end) throw new Error("timed out")
}
function start(socket: string) {
  const state = emptyState()
  const sync = createOfficeSync({
    client: createOfficeClient({ socket }),
    cwd: "/tmp/proj",
    state: () => state,
    mutate: (f) => f(state),
    stream: fast,
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

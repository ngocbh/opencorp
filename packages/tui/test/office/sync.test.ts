import { afterEach, expect, test } from "bun:test"
import type { Message, Question } from "@opencorp/protocol"
import { createFakeOffice, type FakeOffice } from "../fixture/fake-office"
import {
  createOfficeClient,
  emptyState,
  MESSAGE_PAGE,
  openQuestions,
  createOfficeSync,
  type OfficeStatus,
} from "@opencorp/client"
import { until } from "../fixture/until"

const fast = { minDelayMs: 10, maxDelayMs: 40 }
let office: FakeOffice | undefined
let stop = () => {}
afterEach(() => {
  stop()
  office?.stop()
  office = undefined
})
function start(
  socket: string,
  stream = fast,
  maxBuffered?: number,
  timeoutMs?: number,
  onStatus?: (s: OfficeStatus) => void,
) {
  const state = emptyState()
  const sync = createOfficeSync({
    client: createOfficeClient({ socket, timeoutMs }),
    cwd: "/tmp/proj",
    state: () => state,
    mutate: (f) => f(state),
    onStatus,
    stream,
    maxBuffered,
  })
  sync.start()
  stop = sync.stop
  return { state, sync }
}
const count = (o: FakeOffice, what: string) => o.requests.filter((r) => `${r.method} ${r.path}` === what).length
/** The read of session `id`'s newest page of messages, as the sync sends it. */
const newest = (id: string) => `GET /sessions/${id}/messages?limit=${MESSAGE_PAGE}`

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
  await until(() => count(office!, newest(id)) === 1)
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
  const fresh = office.nextId()
  office.state.sessions.unshift({ ...office.state.sessions[0], id: fresh, updated_at: "2099-01-01T00:00:00.000Z" }) // no event
  office.state.messages[id].push({ id: "M9", session_id: id, role: "user", parts: [], created_at: "t" })
  office.reset()
  await until(() => count(office!, "GET /sessions?limit=50") === 2)
  await until(() => state.sessions[0]?.id === fresh && state.messages[id].some((m) => m.id === "M9"))
})

test("after a reconnect, questions opened and answered while away are current", async () => {
  office = createFakeOffice()
  const { state, sync } = start(office.socket)
  await until(() => sync.status() === "online")
  const id = office.state.sessions[0].id
  await sync.syncSession(id)
  const asked = () => openQuestions(state, id)
  const seen = office.addQuestion({})
  await until(() => asked().length === 1)
  office.dropStreams()
  await until(() => sync.status() === "connecting")
  // While the stream is down: one question is answered, another opens; neither event reaches us.
  office.state.questions[seen.id] = { ...seen, status: "answered" }
  const missed = office.addQuestion({})
  await until(() => sync.status() === "online")
  await until(
    () =>
      asked()
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
  office.state.people.push({ ...office.state.people[0], handle: "lan" })
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

const boom = () => {
  throw new Error("listener bug")
}

test("a throwing on() listener doesn't stop the stream or the other listeners", async () => {
  office = createFakeOffice()
  const statuses: OfficeStatus[] = []
  const logged = await quietly(async () => {
    const { sync } = start(office!.socket, fast, undefined, undefined, (s) => statuses.push(s))
    await until(() => sync.status() === "online")
    let seen = 0
    sync.on("question.created", boom)
    sync.on("question.created", () => void seen++)
    for (let i = 0; i < 3; i++) office!.addQuestion({})
    await until(() => seen === 3)
    await Bun.sleep(50)
  })
  expect(statuses).toEqual(["online"])
  expect(count(office, "GET /people")).toBe(1)
  expect(logged.map((args) => args[0])).toEqual(Array(3).fill("Failed to apply an office update"))
})

test("a listener that throws on a buffered bootstrap event leaves the sync online", async () => {
  office = createFakeOffice()
  const statuses: OfficeStatus[] = []
  const release = office.hold("GET /sessions")
  const logged = await quietly(async () => {
    const { sync } = start(office!.socket, fast, undefined, undefined, (s) => statuses.push(s))
    sync.on("question.created", boom)
    await until(() => count(office!, "GET /sessions?limit=50") === 1)
    office!.addQuestion({})
    await Bun.sleep(30)
    release()
    await until(() => sync.status() === "online")
    await Bun.sleep(100)
    expect(sync.status()).toBe("online")
  })
  expect(statuses).toEqual(["online"])
  expect(count(office, "GET /people")).toBe(1)
  expect(logged.map((args) => args[0])).toContain("Failed to apply an office update")
})

test("a listener that throws on a session's replayed window still loads the session", async () => {
  office = createFakeOffice()
  const logged = await quietly(async () => {
    const { state, sync } = start(office!.socket)
    await until(() => sync.status() === "online")
    const id = office!.state.sessions[0].id
    office!.state.messages[id] = [
      { id: "M", session_id: id, role: "assistant", parts: [{ id: "p1", type: "text", text: "hel" }], created_at: "t" },
    ]
    sync.on("part.updated", boom)
    const release = office!.hold("GET /sessions/:id/messages")
    const done = sync.syncSession(id)
    await until(() => count(office!, newest(id)) === 1)
    office!.live({
      type: "part.updated",
      session_id: id,
      data: { message_id: "M", part: { id: "p2", type: "text", text: "world" } },
    })
    await Bun.sleep(30)
    release()
    await done
    expect(state.messages[id][0].parts.map((p) => (p as { text: string }).text)).toEqual(["hel", "world"])
  })
  expect(logged.map((args) => args[0])).toContain("Failed to apply an office update")
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
  const messages = newest(id)
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
  expect(count(office, newest(id))).toBe(1)
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
  await until(() => count(office!, newest(id)) === 1)
  for (let i = 0; i < 10; i++)
    office.live({ type: "part.delta", session_id: id, data: { message_id: "M1", part_id: "M1-p", text: "!" } })
  await until(() => count(office!, "GET /events") === 2)
  release()
  await done
  await until(() => sync.status() === "online")
  expect(state.messages[id].map((m) => m.id)).toEqual(["M1"])
  expect(state.messages[id][0].parts.map((p) => (p as { text: string }).text)).toEqual(["M1"])
})

/** Silences console.error for `fn`, returning what it logged. */
async function quietly(fn: () => Promise<void>) {
  const logged: unknown[][] = []
  const error = console.error
  console.error = (...args: unknown[]) => void logged.push(args)
  try {
    await fn()
  } finally {
    console.error = error
  }
  return logged
}

test("a session that fails to reload doesn't fail the bootstrap, and retries on its own", async () => {
  office = createFakeOffice()
  const s1 = office.state.sessions[0]
  const s2 = office.nextId()
  office.state.sessions.push({ ...s1, id: s2 })
  office.state.messages[s2] = [textMessage(s2, "M1")]
  const { state, sync } = start(office.socket)
  await until(() => sync.status() === "online")
  await Promise.all([sync.syncSession(s1.id), sync.syncSession(s2)])
  const logged = await quietly(async () => {
    // The second session's history can't be read now.
    office!.notImplemented.add(`GET /sessions/${s2}/messages`)
    office!.state.messages[s1.id].push(textMessage(s1.id, "M9"))
    office!.reset()
    await until(() => count(office!, "GET /sessions?limit=50") === 2)
    await until(() => sync.status() === "online" && state.messages[s1.id].some((m) => m.id === "M9"))
    // Once for syncSession, once in the bootstrap, once more on its own after it.
    await until(() => count(office!, newest(s2)) === 3)
    // Still failing, so it stops being synced and its stale transcript goes.
    await until(() => state.messages[s2] === undefined)
  })
  expect(sync.status()).toBe("online")
  expect(logged.length).toBeGreaterThan(0)
})

test("a folder people read that fails keeps the list read before", async () => {
  office = createFakeOffice()
  const { state, sync } = start(office.socket)
  await until(() => sync.status() === "online")
  expect(state.folderPeople.map((p) => p.handle)).toEqual(["minh"])
  await quietly(async () => {
    office!.notImplemented.add("GET /folders/:cwd/people")
    office!.reset()
    await until(() => count(office!, "GET /people") === 2)
    await until(() => sync.status() === "online")
    await sync.refreshPeople()
  })
  expect(state.folderPeople.map((p) => p.handle)).toEqual(["minh"])
})

test("a session load that times out drops the session's messages", async () => {
  office = createFakeOffice()
  const { state, sync } = start(office.socket, fast, undefined, 100)
  await until(() => sync.status() === "online")
  const id = office.state.sessions[0].id
  await sync.syncSession(id)
  expect(state.messages[id]).toBeDefined()
  const release = office.hold("GET /sessions/:id/messages")
  office.reset()
  await quietly(async () => {
    await until(() => count(office!, newest(id)) === 3, 3000)
    await until(() => state.messages[id] === undefined, 3000)
  })
  release()
})

test("a load in flight at stop() neither reads again nor changes state", async () => {
  office = createFakeOffice()
  const { state, sync } = start(office.socket)
  await until(() => sync.status() === "online")
  const id = office.state.sessions[0].id
  office.state.messages[id] = [textMessage(id, "M1")]
  const release = office.hold("GET /sessions/:id/messages")
  const done = sync.syncSession(id)
  await until(() => count(office!, newest(id)) === 1)
  sync.stop()
  release()
  await done
  await Bun.sleep(50)
  expect(count(office, newest(id))).toBe(1)
  expect(state.messages[id]).toEqual([])
})

/** A sync with a custom snapshot that keeps only the first person and counts its reads. */
function startCustom(socket: string, state = emptyState()) {
  const reads = { n: 0 }
  const sync = createOfficeSync({
    client: createOfficeClient({ socket }),
    state: () => state,
    mutate: (fn) => fn(state),
    stream: fast,
    snapshot: async (client) => {
      reads.n++
      const people = await client.people.list()
      return (s) => void (s.people = people.slice(0, 1))
    },
  })
  sync.start()
  stop = () => sync.stop()
  return { state, sync, reads }
}

test("a custom snapshot replaces the default reads, and runs on every connect", async () => {
  office = createFakeOffice()
  const { state, sync, reads } = startCustom(office.socket)
  await until(() => sync.status() === "online")
  expect(state.people.map((p) => p.handle)).toEqual(["minh"])
  expect(state.sessions).toEqual([]) // the default snapshot's session list didn't run
  expect(office.requests.some((r) => r.path.startsWith("/folders/"))).toBe(false)
  office.dropStreams()
  await until(() => reads.n === 2)
})

test("with a custom snapshot, held open questions aren't re-read by id on a reconnect", async () => {
  // HQ serves no GET /questions/{id}: its snapshot re-reads every open question itself.
  office = createFakeOffice()
  const state = emptyState()
  state.questions.Q1 = {
    id: "Q1",
    session_id: "S1",
    run_id: "r",
    node_id: null,
    source: "ask_user",
    asker: "minh",
    question: "?",
    status: "open",
    created_at: "t",
    updated_at: "t",
  } as Question
  const { sync, reads } = startCustom(office.socket, state)
  await until(() => sync.status() === "online")
  office.dropStreams()
  await until(() => reads.n === 2 && sync.status() === "online")
  expect(count(office, "GET /questions/Q1")).toBe(0)
})

/** Marks what `clean` touched, so a test sees which fields went through it. */
const mark = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")

function startClean(socket: string, clean?: (text: string) => string) {
  const state = emptyState()
  const sync = createOfficeSync({
    client: createOfficeClient({ socket }),
    cwd: "/tmp/proj",
    state: () => state,
    mutate: (f) => f(state),
    stream: fast,
    clean,
  })
  sync.start()
  stop = sync.stop
  return { state, sync }
}

/** A loaded message, a live one with a tool part, a part and deltas, each with control characters. */
async function dirtySession(o: FakeOffice, sync: ReturnType<typeof createOfficeSync>) {
  const id = o.state.sessions[0].id
  o.state.messages[id] = [
    {
      id: "L\x07",
      session_id: id,
      role: "user",
      parts: [{ id: "lp", type: "text", text: "load\x07ed" }],
      created_at: "t",
    },
  ]
  const release = o.hold("GET /sessions/:id/messages")
  const done = sync.syncSession(id)
  await until(() => count(o, newest(id)) === 1)
  // Held back while the session loads, then replayed on top of it.
  o.live({
    type: "message.updated",
    session_id: id,
    data: {
      id: "M",
      session_id: id,
      role: "assistant",
      created_at: "t",
      parts: [
        { id: "p1", type: "text", text: "be\x07ll" },
        {
          id: "t1",
          type: "tool",
          call_id: "c\x07",
          tool: "ba\x07sh",
          state: "error",
          input: { command: "ls \x1b[31mred", n: 1, list: ["a\x0eb"] },
          output: "ou\x07t",
          error: "fa\x07il",
        },
        { id: "e1", type: "error", message: "bro\x07ke" },
      ],
    },
  })
  await Bun.sleep(30)
  release()
  await done
  // Applied as they come.
  const part = { id: "p2", type: "text", text: "S\x0eO" }
  o.live({ type: "part.updated", session_id: id, data: { message_id: "M", part } })
  o.live({ type: "part.delta", session_id: id, data: { message_id: "M", part_id: "p2", text: " mo\x1b]0;T\x07re" } })
  return id
}

test("with clean, transcript text and names come in cleaned; ids, sessions and questions stay as sent", async () => {
  office = createFakeOffice()
  office.state.people[0] = { ...office.state.people[0], name: "Min\x07h", title: "CE\x0eO" }
  office.state.sessions[0] = { ...office.state.sessions[0], model_note: "no\x07te" }
  const q = office.addQuestion({ question: "Q\x1b[2J?", options: ["o\x1b[31mne"] })
  const { state, sync } = startClean(office.socket, mark)
  await until(() => sync.status() === "online")
  expect(state.people[0]).toMatchObject({ handle: "minh", name: "Minh", title: "CEO" })
  expect(state.folderPeople[0]).toMatchObject({ handle: "minh", name: "Minh", title: "CEO" })
  const id = await dirtySession(office, sync)
  await until(() => state.messages[id].find((m) => m.id === "M")?.parts.length === 4)
  await until(() => (state.messages[id][1].parts[3] as { text: string }).text === "SO mo]0;Tre")
  expect(state.messages[id]).toEqual([
    {
      id: "L\x07",
      session_id: id,
      role: "user",
      author: null,
      instrument: null,
      unread: false,
      queued: false,
      parts: [{ id: "lp", type: "text", text: "loaded" }],
      created_at: "t",
    },
    {
      id: "M",
      session_id: id,
      role: "assistant",
      created_at: "t",
      parts: [
        { id: "p1", type: "text", text: "bell" },
        {
          id: "t1",
          type: "tool",
          call_id: "c\x07",
          tool: "bash",
          state: "error",
          input: { command: "ls [31mred", n: 1, list: ["ab"] },
          output: "out",
          error: "fail",
        },
        { id: "e1", type: "error", message: "broke" },
        { id: "p2", type: "text", text: "SO mo]0;Tre" },
      ],
    },
  ])
  expect(state.sessions[0].model_note).toBe("no\x07te")
  expect(state.questions[q.id]).toMatchObject({ question: "Q\x1b[2J?", options: ["o\x1b[31mne"] })
  office.state.people[0] = { ...office.state.people[0], name: "Min\x07h 2" }
  await sync.refreshPeople()
  expect(state.people[0].name).toBe("Minh 2")
  expect(state.folderPeople[0].name).toBe("Minh 2")
})

test("without clean, transcript text and names come in exactly as sent", async () => {
  office = createFakeOffice()
  office.state.people[0] = { ...office.state.people[0], name: "Min\x07h" }
  const { state, sync } = startClean(office.socket)
  await until(() => sync.status() === "online")
  expect(state.people[0].name).toBe("Min\x07h")
  const id = await dirtySession(office, sync)
  const text = () => (state.messages[id][1]?.parts[3] as { text: string } | undefined)?.text
  await until(() => text() === "S\x0eO mo\x1b]0;T\x07re")
  expect(state.messages[id][0].parts[0]).toEqual({ id: "lp", type: "text", text: "load\x07ed" })
  expect(state.messages[id][1].parts[1]).toMatchObject({ tool: "ba\x07sh", input: { command: "ls \x1b[31mred" } })
})

/** `n` messages of session `id`, from `from`, by ids that sort as the office's: a user message, then its reply. */
function numbered(id: string, n: number, from = 0): Message[] {
  return Array.from({ length: n }, (_, i) => {
    const k = from + i
    const text = `m${k}`
    return {
      id: `M${String(k).padStart(4, "0")}`,
      session_id: id,
      role: k % 2 === 0 ? ("user" as const) : ("assistant" as const),
      parts: [{ id: `p${k}`, type: "text" as const, text }],
      created_at: "t",
    }
  })
}
const textsOf = (list: Message[] | undefined) => (list ?? []).map((m) => (m.parts[0] as { text: string }).text)
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `m${from + i}`)
const olderReads = (o: FakeOffice, id: string) =>
  o.requests.filter((r) => r.path.startsWith(`/sessions/${id}/messages?`) && r.path.includes("before=")).length

test("a synced session holds its newest page; older pages load before it, a page or all of them", async () => {
  office = createFakeOffice()
  const { state, sync } = start(office.socket)
  await until(() => sync.status() === "online")
  const id = office.state.sessions[0].id
  office.state.messages[id] = numbered(id, 50)
  await sync.syncSession(id)
  expect(textsOf(state.messages[id])).toEqual(range(30, 50))
  expect(state.messageCursor[id]).toEqual(expect.any(String))
  await sync.loadOlder(id)
  expect(textsOf(state.messages[id])).toEqual(range(10, 50))
  await sync.loadOlder(id, { all: true })
  expect(textsOf(state.messages[id])).toEqual(range(0, 50))
  expect(state.messageCursor[id]).toBeUndefined()
  // Every older page at once is as many as the office gives in one.
  expect(office.requests.filter((r) => r.path.includes("before=")).map((r) => r.path.includes("limit=500"))).toEqual([
    false,
    true,
  ])
  // Nothing older is left: no read.
  const reads = olderReads(office, id)
  await sync.loadOlder(id)
  expect(olderReads(office, id)).toBe(reads)
})

test("a live message during an older page's load shows once, after the older messages", async () => {
  office = createFakeOffice()
  const { state, sync } = start(office.socket)
  await until(() => sync.status() === "online")
  const id = office.state.sessions[0].id
  office.state.messages[id] = numbered(id, 30)
  await sync.syncSession(id)
  const release = office.hold("GET /sessions/:id/messages")
  const published: number[] = []
  const loading = sync.loadOlder(id, { beforePublish: () => published.push(state.messages[id]!.length) })
  await until(() => olderReads(office!, id) === 1)
  // A reply's message comes and grows, and a held one is sent again, while the page loads.
  const [late] = numbered(id, 1, 30)
  office.state.messages[id].push(late!)
  office.live({ type: "message.updated", session_id: id, data: late as never })
  office.live({ type: "message.updated", session_id: id, data: numbered(id, 1, 29)[0] as never })
  await until(() => state.messages[id]!.length === 21)
  release()
  await loading
  expect(textsOf(state.messages[id])).toEqual(range(0, 31))
  expect(published).toEqual([21])
})

test("two older loads at once read one page", async () => {
  office = createFakeOffice()
  const { state, sync } = start(office.socket)
  await until(() => sync.status() === "online")
  const id = office.state.sessions[0].id
  office.state.messages[id] = numbered(id, 60)
  await sync.syncSession(id)
  await Promise.all([sync.loadOlder(id), sync.loadOlder(id)])
  expect(olderReads(office, id)).toBe(1)
  expect(textsOf(state.messages[id])).toEqual(range(20, 60))
})

test("a reload of a synced session keeps the older messages it loaded", async () => {
  office = createFakeOffice()
  const { state, sync } = start(office.socket)
  await until(() => sync.status() === "online")
  const id = office.state.sessions[0].id
  office.state.messages[id] = numbered(id, 50)
  await sync.syncSession(id)
  await sync.loadOlder(id)
  const cursor = state.messageCursor[id]
  office.state.messages[id].push(...numbered(id, 2, 50))
  // A reconnect reloads it, and opening it again does too.
  office.reset()
  await until(() => count(office!, newest(id)) === 2)
  await until(() => state.messages[id]!.length === 42)
  await sync.syncSession(id)
  expect(textsOf(state.messages[id])).toEqual(range(10, 52))
  expect(state.messageCursor[id]).toBe(cursor)
})

test("a cursor whose message is gone reloads the newest page in place of what is held", async () => {
  office = createFakeOffice()
  const { state, sync } = start(office.socket)
  await until(() => sync.status() === "online")
  const id = office.state.sessions[0].id
  office.state.messages[id] = numbered(id, 30)
  await sync.syncSession(id)
  // The office's transcript starts over, as a Codex session's does at its next turn.
  office.state.messages[id] = numbered(id, 25, 100)
  await sync.loadOlder(id)
  expect(textsOf(state.messages[id])).toEqual(range(105, 125))
  expect(state.messageCursor[id]).toEqual(expect.any(String))
})

test.each(["request", "reply"] as const)(
  "a live change to an older message while its page loads goes on the page, whichever the office read first [%s]",
  async (at) => {
    office = createFakeOffice()
    const { state, sync } = start(office.socket)
    await until(() => sync.status() === "online")
    const id = office.state.sessions[0].id
    office.state.messages[id] = numbered(id, 30)
    await sync.syncSession(id)
    // With "reply", the office reads the page before the change; with "request", after it.
    const release = office.hold("GET /sessions/:id/messages", at)
    const loading = sync.loadOlder(id)
    await until(() => olderReads(office!, id) === 1)
    const edited = { ...numbered(id, 1, 5)[0]!, parts: [{ id: "p5", type: "text" as const, text: "m5 edited" }] }
    office.state.messages[id][5] = edited
    office.live({ type: "message.updated", session_id: id, data: edited as never })
    office.state.messages[id].splice(3, 1)
    office.live({ type: "message.removed", session_id: id, data: { id: "M0003", session_id: id } as never })
    await Bun.sleep(30)
    release()
    await loading
    expect(textsOf(state.messages[id])).toEqual(["m0", "m1", "m2", "m4", "m5 edited", ...range(6, 30)])
    // What comes after the page goes on as before.
    office.live({ type: "message.updated", session_id: id, data: { ...edited, parts: [{ id: "p5", type: "text", text: "m5 again" }] } as never })
    await until(() => textsOf(state.messages[id]).includes("m5 again"))
  },
)

test("every older page, past a cursor whose message is gone, is the whole new transcript", async () => {
  office = createFakeOffice()
  const { state, sync } = start(office.socket)
  await until(() => sync.status() === "online")
  const id = office.state.sessions[0].id
  office.state.messages[id] = numbered(id, 30)
  await sync.syncSession(id)
  office.state.messages[id] = numbered(id, 45, 100)
  await sync.loadOlder(id, { all: true })
  expect(textsOf(state.messages[id])).toEqual(range(100, 145))
  expect(state.messageCursor[id]).toBeUndefined()
})

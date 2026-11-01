/** HQ's /api/events: the /events contract, HQ's event types only, and the session checked on every frame. */
import net from "node:net"
import { expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import { Event, type LiveEvent, now } from "@opencorp/protocol"
import { hashPassword } from "../../src/auth/passwords.ts"
import type { Office } from "../../src/daemon/office.ts"
import { HQ_EVENT_TYPES } from "../../src/hq/api.ts"
import type { Hq } from "../../src/hq/core.ts"
import { STREAMS_PER_SESSION, TTL } from "../../src/hq/sessions.ts"
import { newId } from "../../src/store/store.ts"
import { waitFor } from "../helpers.ts"
import {
  CEO,
  type Frame,
  ends,
  frames,
  joinedRun,
  makeOffice,
  socketCapacity,
  stopsPulling,
  storedRun,
  take,
  within,
} from "../daemon/helpers.ts"
import { type HqClient, handEdit, hqClient, makeHq, pairCode } from "./helpers.ts"

setDefaultTimeout(30_000)

function meta(type: string, subject = "S", data: Record<string, unknown> = {}): Event {
  return { id: newId(), type: type as Event["type"], at: now(), subject_id: subject, data }
}

function partDelta(): LiveEvent {
  return { type: "part.delta", session_id: newId(), data: { message_id: "m", part_id: "p", text: "x" } }
}

/** An office with HQ attached, `logs` getting HQ's log lines, and a client signed in over the hq.sock flavour of
 *  the HQ app (Python's `hq_served`). */
async function served(): Promise<{ office: Office; hq: Hq; client: HqClient; logs: string[] }> {
  const office = makeOffice()
  const logs: string[] = []
  const hq = await makeHq(office, { logs })
  const client = await hqClient(hq, {
    port: null,
    peer: null,
    host: "127.0.0.1:5555",
    headers: { origin: "http://127.0.0.1:5555" },
  })
  expect((await client.post("/api/pair", { code: await pairCode(hq) })).status).toBe(200)
  return { office, hq, client, logs }
}

/** Publishes an HQ event every 10 ms, so the stream always has a frame to send; clear the returned timer. */
function busy(office: Office): ReturnType<typeof setInterval> {
  return setInterval(() => office.bus.publishMeta(meta("session.updated", "S", { id: "S" })), 10)
}

/** A raw connection asking for `target` with the client's cookies, paused once the head arrives, and what it got
 *  once it read again: `closed()` resumes it and resolves with everything it then received, at the close. */
async function paused(client: HqClient, target: string): Promise<{ socket: net.Socket; closed: () => Promise<string> }> {
  const socket = net.connect(client.sock)
  onTestFinished(() => socket.destroy())
  socket.on("error", () => {})
  const cookie = [...client.cookies].map(([name, value]) => `${name}=${value}`).join("; ")
  socket.write(
    `GET ${target} HTTP/1.1\r\nhost: 127.0.0.1:5555\r\norigin: http://127.0.0.1:5555\r\ncookie: ${cookie}\r\n` +
      "connection: close\r\n\r\n",
  )
  await new Promise<void>((resolve) => socket.once("data", () => resolve()))
  socket.pause()
  const closed = () =>
    new Promise<string>((resolve) => {
      const parts: Buffer[] = []
      socket.on("data", (part: Buffer) => parts.push(part))
      socket.on("close", () => resolve(Buffer.concat(parts).toString()))
      socket.resume()
    })
  return { socket, closed }
}

/** Leaves `/api/events` streams waiting for their paused clients: publishes large frames, paced, until `alive`, which a
 *  stream checks before every frame, stops being called. Waited for rather than sized, since socket buffers differ by
 *  host. */
async function stall(office: Office, hq: Hq): Promise<void> {
  const alive = spyOn(hq.sessions, "alive")
  const big = "x".repeat(256 * 1024)
  const feed = setInterval(() => office.bus.publishMeta(meta("session.updated", "S", { big })), 5)
  try {
    await stopsPulling(() => alive.mock.calls.length)
  } finally {
    clearInterval(feed)
    alive.mockRestore()
  }
}

/** Reads frames until `it` ends, within 5 s. */
async function drain(it: AsyncIterator<Frame>): Promise<void> {
  await within(
    (async () => {
      while (!(await it.next()).done);
    })(),
  )
}

test("only hq event types arrive", async () => {
  const { office, client } = await served()
  const res = await client.stream("/api/events")
  expect(res.headers["content-type"]).toStartWith("text/event-stream")
  const it = frames(res)
  expect(await take(it, 1)).toEqual([["comment", null, "connected"]])
  office.bus.publishLive(partDelta())
  office.bus.publishLive({ type: "message.updated", session_id: newId(), data: {} })
  const others = Event.shape.type.options.filter((t) => !HQ_EVENT_TYPES.has(t))
  expect(others).toEqual(
    expect.arrayContaining([
      "profile.updated",
      "profile_proposal.created",
      "profile_proposal.updated",
      "comment.created",
    ]),
  )
  for (const t of [...others].sort()) office.bus.publishMeta(meta(t))
  const head = await office.git.readHead()
  const types = [
    "session.created",
    "session.updated",
    "question.created",
    "question.updated",
    "work_item.created",
    "work_item.updated",
    "run.updated",
  ]
  const sent = [...types.map((t) => meta(t)), meta("company.updated", head, { sha: head })]
  for (const event of sent) office.bus.publishMeta(event)
  const got = await take(it, sent.length)
  expect(got.map(([kind, id, data]) => [kind, id, (data as Event).type])).toEqual(
    sent.map((e) => ["meta", e.id, e.type]),
  )
})

test("idle stream gets pings", async () => {
  const { hq, client } = await served()
  hq.pingMs = 50
  expect(await take(frames(await client.stream("/api/events")), 2)).toEqual([
    ["comment", null, "connected"],
    ["comment", null, "ping"],
  ])
})

test("a dropped stream gets reset then ends", async () => {
  const { office, client } = await served()
  office.bus.queueSize = 3
  const it = frames(await client.stream("/api/events"))
  await take(it, 1)
  // In one go, so the backlog overflows before the stream reads it.
  for (let i = 0; i < 10; i++) office.bus.publishMeta(meta("session.updated"))
  expect(await take(it, 1)).toEqual([["reset", null, null]])
  expect(await ends(it)).toBe(true)
})

test("events need a session and refuse head", async () => {
  const { office, client } = await served()
  const head = await client.request("HEAD", "/api/events")
  expect([head.status, head.headers.allow]).toEqual([405, "GET"])
  client.cookies.clear()
  const r = await client.get("/api/events")
  expect([r.status, (r.json() as { error: string }).error]).toEqual([401, "sign_in_required"])
  expect(office.bus.subscriberCount).toBe(0)
})

test("a closed stream is unregistered", async () => {
  const { office, hq, client } = await served()
  const sid = office.store.listHqSessions()[0]!.id
  const res = await client.stream("/api/events")
  await take(frames(res), 1)
  expect(hq.sessions.streams(sid)).toBe(1)
  res.destroy()
  await waitFor(() => office.bus.subscriberCount === 0 && hq.sessions.streams(sid) === 0, {
    timeout: 5000,
    what: "the stream to be unregistered",
  })
})

test("revoking ends a busy stream", async () => {
  const { office, hq, client } = await served()
  const sid = office.store.listHqSessions()[0]!.id
  const it = frames(await client.stream("/api/events"))
  expect(await take(it, 1)).toEqual([["comment", null, "connected"]])
  const noise = busy(office)
  try {
    await take(it, 3)
    await hq.sessions.revoke(sid)
    await drain(it)
    expect(office.bus.subscriberCount).toBe(0)
    expect(hq.sessions.streams(sid)).toBe(0)
  } finally {
    clearInterval(noise)
  }
})

test("expiry ends a busy stream", async () => {
  const { office, hq, client } = await served()
  const it = frames(await client.stream("/api/events"))
  expect(await take(it, 1)).toEqual([["comment", null, "connected"]])
  const noise = busy(office)
  try {
    await take(it, 3)
    // Past any session issued now.
    hq.sessions.clock = () => new Date(Date.now() + 2 * TTL)
    await drain(it)
    expect(office.bus.subscriberCount).toBe(0)
  } finally {
    clearInterval(noise)
  }
})

test("expiry ends an idle stream at its next ping", async () => {
  const { office, hq, client } = await served()
  hq.pingMs = 50
  const it = frames(await client.stream("/api/events"))
  await take(it, 1)
  hq.sessions.clock = () => new Date(Date.now() + 2 * TTL)
  await drain(it)
  expect(office.bus.subscriberCount).toBe(0)
})

test("a password change ends the stream at company updated", async () => {
  const { office, client } = await served()
  const it = frames(await client.stream("/api/events"))
  await take(it, 1)
  handEdit(office.paths.company, CEO, { password_hash: await hashPassword("brand new one") })
  const sha = await office.git.readHead()
  office.store.emit("company.updated", sha, { sha })
  // No company.updated frame first.
  expect(await ends(it)).toBe(true)
  expect(office.bus.subscriberCount).toBe(0)
  expect((await client.get("/api/whoami")).status).toBe(401)
})

test("a failing recheck ends the stream quietly and keeps the session", async () => {
  const { office, hq, client, logs } = await served()
  const sid = office.store.listHqSessions()[0]!.id
  const it = frames(await client.stream("/api/events"))
  await take(it, 1)
  // No such commit, so loading its fingerprints fails.
  const sha = "f".repeat(40)
  office.store.emit("company.updated", sha, { sha })
  await drain(it)
  expect(office.bus.subscriberCount).toBe(0)
  expect(hq.sessions.streams(sid)).toBe(0)
  expect(office.store.getHqSession(sid)).toBeDefined()
  const said = logs.filter((line) => line.includes(`couldn't re-check HQ session ${sid} at ${sha}; ending its stream`))
  // The error's type only, never its message.
  expect(said).toEqual([expect.stringMatching(/; ending its stream: \w+$/)])
  expect(logs.some((line) => line.includes("internal error"))).toBe(false)
})

test("an unreadable person file ends the stream but not the session", async () => {
  const { office, hq, client } = await served()
  const sid = office.store.listHqSessions()[0]!.id
  const it = frames(await client.stream("/api/events"))
  await take(it, 1)
  handEdit(office.paths.company, CEO, { kind: "robot" })
  const sha = await office.git.readHead()
  office.store.emit("company.updated", sha, { sha })
  // No company.updated frame first.
  expect(await ends(it)).toBe(true)
  expect(office.bus.subscriberCount).toBe(0)
  expect(hq.sessions.streams(sid)).toBe(0)
  expect(office.store.getHqSession(sid)).toBeDefined()
  expect((await client.get("/api/whoami")).status).toBe(401)
  handEdit(office.paths.company, CEO, { kind: "human" })
  expect((await client.get("/api/whoami")).status).toBe(200)
})

test("revoking closes a stalled events stream", async () => {
  const { office, hq, client } = await served()
  const sid = office.store.listHqSessions()[0]!.id
  const stream = await paused(client, "/api/events")
  await stall(office, hq)
  await hq.sessions.revoke(sid)
  // Cut while it waited for the client: the stream's last chunk never went out.
  expect((await within(stream.closed())).endsWith("0\r\n\r\n")).toBe(false)
  expect(hq.sessions.streams(sid)).toBe(0)
})

test("revoking closes a stalled live stream", async () => {
  const { office, hq, client } = await served()
  const sid = office.store.listHqSessions()[0]!.id
  // A log far past what a paused client's socket takes (a turn is over 1000 bytes; socket buffers differ by host), so
  // the stream waits for the client before its end.
  const capacity = await socketCapacity(Buffer.alloc(64 * 1024))
  const { runId } = storedRun(office, { turns: Math.max(3000, Math.ceil((2 * capacity) / 1000)) })
  const alive = spyOn(hq.sessions, "alive")
  const stream = await paused(client, `/api/runs/${runId}/live`)
  await stopsPulling(() => alive.mock.calls.length)
  alive.mockRestore()
  expect(hq.sessions.streams(sid)).toBe(1) // waiting for the client, not done
  await hq.sessions.revoke(sid)
  const got = await within(stream.closed())
  expect(got.endsWith("0\r\n\r\n")).toBe(false)
  expect(got.includes("event: run_end")).toBe(false)
  await waitFor(() => hq.sessions.streams(sid) === 0, { timeout: 5000, what: "the stream to be released" })
})

test("a password change closes a stalled events stream", async () => {
  const { office, hq, client } = await served()
  const sid = office.store.listHqSessions()[0]!.id
  const stream = await paused(client, "/api/events")
  await stall(office, hq)
  handEdit(office.paths.company, CEO, { password_hash: await hashPassword("brand new one") })
  const sha = await office.git.readHead()
  office.store.emit("company.updated", sha, { sha })
  // Released only once the cut ends it: until the client reads again, nothing else can.
  await waitFor(() => hq.sessions.streams(sid) === 0, { timeout: 5000, what: "the stream to be cut" })
  expect((await within(stream.closed())).endsWith("0\r\n\r\n")).toBe(false)
  expect((await client.get("/api/whoami")).status).toBe(401)
})

test("an unreadable person file closes a stalled events stream but keeps the session", async () => {
  const { office, hq, client } = await served()
  const sid = office.store.listHqSessions()[0]!.id
  const stream = await paused(client, "/api/events")
  await stall(office, hq)
  handEdit(office.paths.company, CEO, { kind: "robot" })
  const sha = await office.git.readHead()
  office.store.emit("company.updated", sha, { sha })
  // Released only once the cut ends it: until the client reads again, nothing else can.
  await waitFor(() => hq.sessions.streams(sid) === 0, { timeout: 5000, what: "the stream to be cut" })
  expect((await within(stream.closed())).endsWith("0\r\n\r\n")).toBe(false)
  expect(office.store.getHqSession(sid)).toBeDefined()
})

test("a stream past the sessions cap ends its oldest", async () => {
  const { office, hq, client } = await served()
  const sid = office.store.listHqSessions()[0]!.id
  // A run a worker feeds, so its live stream stays open: the cap counts it with the event streams.
  const { runId } = joinedRun(office)
  const first = frames(await client.stream(`/api/runs/${runId}/live`))
  await take(first, 1)
  const rest: AsyncIterator<Frame>[] = []
  for (let i = 1; i < STREAMS_PER_SESSION; i++) {
    const it = frames(await client.stream("/api/events"))
    await take(it, 1)
    rest.push(it)
  }
  expect(hq.sessions.streams(sid)).toBe(STREAMS_PER_SESSION)
  const ninth = frames(await client.stream("/api/events"))
  expect(await take(ninth, 1)).toEqual([["comment", null, "connected"]])
  await drain(first)
  expect(hq.sessions.streams(sid)).toBe(STREAMS_PER_SESSION)
})

test("a burst of streams leaves the sessions cap open", async () => {
  const { office, hq, client } = await served()
  const sid = office.store.listHqSessions()[0]!.id
  const opened = await Promise.all(Array.from({ length: 12 }, () => client.stream("/api/events")))
  expect(opened.map((res) => res.statusCode)).toEqual(Array(12).fill(200))
  let ended = 0
  for (const res of opened) {
    res.on("end", () => ended++)
    res.resume()
  }
  await waitFor(() => ended === 12 - STREAMS_PER_SESSION, { timeout: 5000, what: "the oldest streams to end" })
  expect(hq.sessions.streams(sid)).toBe(STREAMS_PER_SESSION)
})

test("a client that leaves before the stream starts holds no slot", async () => {
  const { office, hq, client } = await served()
  const sid = office.store.listHqSessions()[0]!.id
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const real = hq.sessions.check.bind(hq.sessions)
  let checking!: () => void
  const checked = new Promise<void>((resolve) => (checking = resolve))
  hq.sessions.check = async (cookie) => {
    checking()
    await gate
    return real(cookie)
  }
  const socket = net.connect(client.sock)
  socket.on("error", () => {})
  const cookie = [...client.cookies].map(([name, value]) => `${name}=${value}`).join("; ")
  socket.write(
    `GET /api/events HTTP/1.1\r\nhost: 127.0.0.1:5555\r\norigin: http://127.0.0.1:5555\r\ncookie: ${cookie}\r\n\r\n`,
  )
  await checked
  socket.destroy()
  await new Promise((resolve) => setTimeout(resolve, 100))
  release()
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(hq.sessions.streams(sid)).toBe(0)
  expect(office.bus.subscriberCount).toBe(0)
})

test("a refused live stream holds no slot", async () => {
  const { office, hq, client } = await served()
  const sid = office.store.listHqSessions()[0]!.id
  expect((await client.get(`/api/runs/${newId()}/live`)).status).toBe(404)
  const { runId } = storedRun(office)
  expect((await client.request("HEAD", `/api/runs/${runId}/live`)).status).toBe(405)
  expect((await client.request("HEAD", "/api/events")).status).toBe(405)
  expect(hq.sessions.streams(sid)).toBe(0)
})

/** GET /events over a real socket. */
import http from "node:http"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { type Event, type LiveEvent, now } from "@opencorp/protocol"
import { newId } from "../../src/store/store.ts"
import { waitFor } from "../helpers.ts"
import { recordEvents, session } from "../store/helpers.ts"
import { Conn, ends, frames, makeOffice, served, take } from "./helpers.ts"

setDefaultTimeout(30_000)

/** Opens `target` with a `node:http` request; resolves with the response, whose data events stream. The request
 *  is destroyed when the test finishes. */
function openEvents(sock: string, target = "/events"): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, path: target, agent: false }, (res) => {
      // The cleanup's destroy cuts an unfinished response, which then errors with nobody reading it.
      res.on("error", () => {})
      resolve(res)
    })
    onTestFinished(() => req.destroy())
    req.on("error", reject)
    req.end()
  })
}

function delta(sessionId: string, text: string): LiveEvent {
  return { type: "part.delta", session_id: sessionId, data: { message_id: "m", part_id: "p", text } }
}

test("session events arrive in order after connected", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const res = await openEvents(sock)
  expect(res.headers["content-type"]).toStartWith("text/event-stream")
  const it = frames(res)
  expect(await take(it, 1)).toEqual([["comment", null, "connected"]])
  const stored = recordEvents(office.store)
  const s = office.store.createSession(session())
  office.store.updateSession(s.id, { status: "busy" })
  office.store.updateSession(s.id, { status: "idle" })
  const got = await take(it, 3)
  expect(got.map(([kind, id]) => [kind, id])).toEqual(stored.map((event) => ["meta", event.id]))
  expect(got.map(([, , data]) => (data as Event).type)).toEqual([
    "session.created",
    "session.updated",
    "session.updated",
  ])
  expect((got.at(-1)![2] as Event).data.status).toBe("idle")
})

test("session filter", async () => {
  const office = makeOffice()
  const a = office.store.createSession(session())
  const b = office.store.createSession(session())
  const { sock } = await served(office)
  const it = frames(await openEvents(sock, `/events?session=${a.id}`))
  await take(it, 1)
  office.store.updateSession(b.id, { status: "busy" })
  office.store.updateSession(a.id, { status: "busy" })
  const [[, , data]] = await take(it, 1)
  expect((data as Event).subject_id).toBe(a.id)
})

test("live events are framed as live", async () => {
  const office = makeOffice()
  const s = office.store.createSession(session())
  const live = delta(s.id, "he")
  const { sock } = await served(office)
  const it = frames(await openEvents(sock))
  await take(it, 1)
  office.bus.publishLive(live)
  expect(await take(it, 1)).toEqual([["live", null, live]])
})

test("idle stream gets pings", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { pingMs: 50 })
  const it = frames(await openEvents(sock))
  expect(await take(it, 2)).toEqual([
    ["comment", null, "connected"],
    ["comment", null, "ping"],
  ])
})

test("shutdown ends open streams", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const it = frames(await openEvents(sock))
  await take(it, 1)
  office.bus.close()
  expect(await ends(it)).toBe(true)
})

test("client disconnect drops its subscription", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const res = await openEvents(sock)
  await take(frames(res), 1)
  expect(office.bus.subscriberCount).toBe(1)
  res.destroy()
  await waitFor(() => office.bus.subscriberCount === 0, { timeout: 5000, what: "the subscription to drop" })
})

test("a dropped subscriber gets reset then the stream ends", async () => {
  const office = makeOffice()
  const s = office.store.createSession(session())
  office.bus.queueSize = 3
  const { sock } = await served(office)
  const it = frames(await openEvents(sock))
  await take(it, 1)
  // Published in one go, so the backlog overflows before the stream reads it.
  for (let i = 0; i < 10; i++) office.bus.publishLive(delta(s.id, String(i)))
  expect(await take(it, 1)).toEqual([["reset", null, null]])
  expect(await ends(it)).toBe(true)
})

test("head is 405 and leaves the connection usable", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const conn = await Conn.open(sock)
  conn.send("HEAD /events HTTP/1.1\r\nhost: office\r\n\r\n")
  const head = await conn.response({ head: true })
  expect(head.status).toBe(405)
  expect(head.head).toMatch(/\r\nallow: GET\r\n/i)
  // A plain request after it is answered, so the connection still serves requests.
  conn.send("GET /people HTTP/1.1\r\nhost: office\r\n\r\n")
  const next = await conn.response()
  expect(next.status).toBe(200)
  expect(office.bus.subscriberCount).toBe(0)
})

test("the socket stream still carries every type", async () => {
  // HQ's stream filters by type; the socket's must not.
  const types: Event["type"][] = [
    "profile.updated",
    "feedback.created",
    "debrief.updated",
    "profile_proposal.created",
    "comment.created",
    "session.updated",
  ]
  const office = makeOffice()
  const { sock } = await served(office)
  const it = frames(await openEvents(sock))
  await take(it, 1)
  office.bus.publishLive(delta(newId(), "x"))
  for (const type of types) office.bus.publishMeta({ id: newId(), type, at: now(), subject_id: "S", data: {} })
  const got = await take(it, 1 + types.length)
  const expected = [["live", "part.delta"], ...types.map((type) => ["meta", type])]
  expect(got.map(([kind, , data]) => [kind, (data as { type: string }).type])).toEqual(expected)
})

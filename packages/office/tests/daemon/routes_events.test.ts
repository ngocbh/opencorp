/** GET /events over a real socket. */
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { type Event, type LiveEvent, Message, now } from "@opencorp/protocol"
import type { Office } from "../../src/daemon/office.ts"
import { newId } from "../../src/store/store.ts"
import { waitFor } from "../helpers.ts"
import { recordEvents, session } from "../store/helpers.ts"
import { newToken, tokenSha256 } from "../../src/auth/tokens.ts"
import { git } from "../company/helpers.ts"
import {
  CEO,
  Conn,
  bearer,
  ends,
  frames,
  giveDevice,
  makeOffice,
  request,
  served,
  standInHarness,
  take,
  within,
} from "./helpers.ts"

setDefaultTimeout(30_000)

/** Opens `target` with a `node:http` request; resolves with the response, whose data events stream. The request
 *  is destroyed when the test finishes. */
function openEvents(
  sock: string,
  target = "/events",
  headers: Record<string, string> = {},
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, path: target, headers, agent: false }, (res) => {
      // The cleanup's destroy cuts an unfinished response, which then errors with nobody reading it.
      res.on("error", () => {})
      resolve(res)
    })
    onTestFinished(() => req.destroy())
    req.on("error", reject)
    req.end()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

test("late subscriber gets history from messages not replay", async () => {
  const office = makeOffice()
  const s = office.store.createSession(session())
  const m = Message.parse({
    id: newId(),
    session_id: s.id,
    role: "assistant",
    parts: [{ id: newId(), type: "text", text: "done" }],
    created_at: now(),
  })
  office.harness = standInHarness({ messages: () => [m] })
  const { sock } = await served(office)
  office.bus.publishLive({ type: "message.updated", session_id: s.id, data: m })
  await Bun.sleep(100)
  const it = frames(await openEvents(sock, `/events?session=${s.id}`))
  await take(it, 1)
  office.store.updateSession(s.id, { status: "idle" })
  const [[kind, , data]] = await take(it, 1)
  // The earlier live event is not replayed.
  expect([kind, (data as Event).type]).toEqual(["meta", "session.updated"])
  expect((await request(sock, "GET", `/sessions/${s.id}/messages`)).json()).toEqual([m])
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

test("a dropped subscriber that is not reading has its connection cut", async () => {
  const office = makeOffice()
  const s = office.store.createSession(session())
  office.bus.queueSize = 4
  const { sock } = await served(office)
  const conn = await Conn.open(sock)
  conn.send("GET /events HTTP/1.1\r\nhost: office\r\nconnection: close\r\n\r\n")
  await waitFor(() => conn.socket.bytesRead > 0, { timeout: 9000, what: "the stream to start" })
  conn.socket.pause()
  // Paced, so the stream writes until the paused socket is full and then its queue overflows while it waits.
  const big = "x".repeat(256 * 1024)
  for (let i = 0; office.bus.subscriberCount > 0; i++) {
    if (i > 2000) throw new Error("the stream was never dropped")
    office.bus.publishLive(delta(s.id, big))
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const parts: Buffer[] = []
  await new Promise<void>((resolve) => {
    conn.socket.on("data", (part: Buffer) => parts.push(part))
    conn.socket.on("close", () => resolve())
    conn.socket.resume()
  })
  // Cut while waiting, so it never got to send the reset frame: any end of the stream means bootstrap again.
  expect(Buffer.concat(parts).toString().includes("event: reset")).toBe(false)
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
    "profile_proposal.created",
    "profile_proposal.updated",
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

/** An office serving with device tokens, whose CEO has the devices `mac` and `pc`; their tokens. */
async function twoDevices(): Promise<{ office: Office; sock: string; mac: string; pc: string }> {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const [mac, pc] = [newToken(), newToken()]
  giveDevice(office.paths.company, CEO, "mac", mac)
  giveDevice(office.paths.company, CEO, "pc", pc)
  return { office, sock, mac, pc }
}

test("removing a device ends the streams its token opened", async () => {
  const { sock, mac, pc } = await twoDevices()
  const gone = frames(await openEvents(sock, "/events", bearer(mac)))
  const kept = frames(await openEvents(sock, "/events", bearer(pc)))
  await take(gone, 1)
  await take(kept, 1)
  const r = await request(sock, "DELETE", `/people/${CEO}/devices/mac`, { headers: bearer(pc) })
  expect(r.status).toBe(200)
  // Ended by the removal itself: no company.updated is recorded here.
  expect(await ends(gone)).toBe(true)
  const reconnect = await request(sock, "GET", "/whoami", { headers: bearer(mac) })
  expect([reconnect.status, (reconnect.json() as { error: string }).error]).toEqual([401, "bad_token"])
  expect(await within(Promise.race([kept.next().then(() => "frame"), sleep(200).then(() => "open")]))).toBe("open")
})

test("a commit giving a device a new token ends the old tokens streams at company updated", async () => {
  const { office, sock, mac } = await twoDevices()
  const it = frames(await openEvents(sock, "/events", bearer(mac)))
  await take(it, 1)
  // The same name with a new token, as a hand edit would leave it.
  const file = path.join(office.paths.company, "people", CEO, "person.yaml")
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(tokenSha256(mac), tokenSha256(newToken())))
  git(office.paths.company, "commit", "-qam", "new token for mac")
  const sha = await office.git.readHead()
  office.store.emit("company.updated", sha, { sha })
  const rest: string[] = []
  for (let step = await within(it.next()); !step.done; step = await within(it.next())) rest.push(step.value[0])
  expect(rest.filter((kind) => kind !== "meta")).toEqual([])
})

test("a tokenless stream ends once the first device is added", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const it = frames(await openEvents(sock))
  await take(it, 1)
  const body = { name: "mac", token_sha256: tokenSha256(newToken()) }
  const headers = { "content-type": "application/json" }
  const r = await request(sock, "POST", `/people/${CEO}/devices`, { headers, body: JSON.stringify(body) })
  expect(r.status).toBe(200)
  const rest: string[] = []
  for (let step = await within(it.next()); !step.done; step = await within(it.next())) rest.push(step.value[0])
  expect(rest.filter((kind) => kind !== "meta")).toEqual([])
})

test("removing a device cuts its stream while the client is not reading", async () => {
  const { office, sock, mac, pc } = await twoDevices()
  const s = office.store.createSession(session())
  const conn = await Conn.open(sock)
  conn.send(`GET /events HTTP/1.1\r\nhost: office\r\nauthorization: Bearer ${mac}\r\nconnection: close\r\n\r\n`)
  await waitFor(() => conn.socket.bytesRead > 0, { timeout: 9000, what: "the stream to start" })
  conn.socket.pause()
  const big = "x".repeat(4 * 1024 * 1024)
  for (let i = 0; i < 2; i++) office.bus.publishLive(delta(s.id, big))
  await sleep(300)
  expect((await request(sock, "DELETE", `/people/${CEO}/devices/mac`, { headers: bearer(pc) })).status).toBe(200)
  const parts: Buffer[] = []
  await within(
    new Promise<void>((resolve) => {
      conn.socket.on("data", (part: Buffer) => parts.push(part))
      conn.socket.on("close", () => resolve())
      conn.socket.resume()
    }),
  )
  // Cut while it waited for the client: the stream's last chunk never went out.
  expect(Buffer.concat(parts).toString().endsWith("0\r\n\r\n")).toBe(false)
})

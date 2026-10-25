/** HQ's /api/events: the /events contract, HQ's event types only, and the session checked on every frame. */
import { expect, setDefaultTimeout, test } from "bun:test"
import { Event, type LiveEvent, now } from "@opencorp/protocol"
import { hashPassword } from "../../src/auth/passwords.ts"
import type { Office } from "../../src/daemon/office.ts"
import { HQ_EVENT_TYPES } from "../../src/hq/api.ts"
import type { Hq } from "../../src/hq/core.ts"
import { TTL } from "../../src/hq/sessions.ts"
import { newId } from "../../src/store/store.ts"
import { waitFor } from "../helpers.ts"
import { CEO, type Frame, ends, frames, makeOffice, take, within } from "../daemon/helpers.ts"
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
      "feedback.created",
      "debrief.updated",
      "profile_proposal.created",
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
  } finally {
    clearInterval(noise)
  }
})

test("expiry ends an idle stream at its next ping", async () => {
  const { hq, client } = await served()
  hq.pingMs = 50
  const it = frames(await client.stream("/api/events"))
  await take(it, 1)
  hq.sessions.clock = () => new Date(Date.now() + 2 * TTL)
  await drain(it)
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
  expect((await client.get("/api/whoami")).status).toBe(401)
})

test("a failing recheck ends the stream quietly and keeps the session", async () => {
  const { office, client, logs } = await served()
  const sid = office.store.listHqSessions()[0]!.id
  const it = frames(await client.stream("/api/events"))
  await take(it, 1)
  // No such commit, so loading its fingerprints fails.
  const sha = "f".repeat(40)
  office.store.emit("company.updated", sha, { sha })
  await drain(it)
  expect(office.store.getHqSession(sid)).toBeDefined()
  const said = logs.filter((line) => line.includes(`couldn't re-check HQ session ${sid} at ${sha}; ending its stream`))
  // The error's type only, never its message.
  expect(said).toEqual([expect.stringMatching(/; ending its stream: \w+$/)])
  expect(logs.some((line) => line.includes("internal error"))).toBe(false)
})

test("an unreadable person file ends the stream but not the session", async () => {
  const { office, client } = await served()
  const sid = office.store.listHqSessions()[0]!.id
  const it = frames(await client.stream("/api/events"))
  await take(it, 1)
  handEdit(office.paths.company, CEO, { kind: "robot" })
  const sha = await office.git.readHead()
  office.store.emit("company.updated", sha, { sha })
  // No company.updated frame first.
  expect(await ends(it)).toBe(true)
  expect(office.store.getHqSession(sid)).toBeDefined()
  expect((await client.get("/api/whoami")).status).toBe(401)
  handEdit(office.paths.company, CEO, { kind: "human" })
  expect((await client.get("/api/whoami")).status).toBe(200)
})

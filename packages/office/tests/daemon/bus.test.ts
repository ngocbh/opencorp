/** The bus fans meta and live events out to subscribers. */
import { expect, test } from "bun:test"
import { now, type Event, type LiveEvent } from "@opencorp/protocol"
import { Bus, PING, type Item } from "../../src/daemon/bus.ts"
import { newId } from "../../src/store/store.ts"

const S1 = newId()
const S2 = newId()

function meta(subject: string, type: Event["type"] = "session.updated", data: Record<string, unknown> = {}): Event {
  return { id: newId(), type, at: now(), subject_id: subject, data }
}

function live(sessionId: string, text = "x"): LiveEvent {
  return { type: "part.delta", session_id: sessionId, data: { message_id: "m", part_id: "p", text } }
}

/** The text of a live item `next` returned. */
function text(got: Item | typeof PING | null): unknown {
  if (got === null || got === PING || got[0] !== "live") throw new Error(`not a live item: ${String(got)}`)
  return got[1].data.text
}

test("events arrive in publish order", async () => {
  const bus = new Bus()
  const sub = bus.subscribe()
  const a = meta(S1)
  const b = live(S1)
  const c = meta(S2)
  bus.publishMeta(a)
  bus.publishLive(b)
  bus.publishMeta(c)
  const got = [await sub.next(1000), await sub.next(1000), await sub.next(1000)]
  expect(got).toEqual([["meta", a], ["live", b], ["meta", c]])
})

test("session filter matches subject data and live session", async () => {
  const bus = new Bus()
  const sub = bus.subscribe(S1)
  const q = meta(newId(), "question.created", { session_id: S1 })
  const mine = live(S1)
  bus.publishMeta(meta(S2))
  bus.publishMeta(q)
  bus.publishLive(live(S2))
  bus.publishLive(mine)
  const own = meta(S1)
  bus.publishMeta(own)
  const got = [await sub.next(1000), await sub.next(1000), await sub.next(1000)]
  expect(got).toEqual([["meta", q], ["live", mine], ["meta", own]])
  expect(await sub.next(50)).toBe(PING)
})

test("slow subscriber is dropped and others keep going", async () => {
  const bus = new Bus({ queueSize: 3 })
  const slow = bus.subscribe()
  const fast = bus.subscribe()
  for (let i = 0; i < 5; i++) {
    bus.publishLive(live(S1, String(i)))
    expect(text(await fast.next(1000))).toBe(String(i))
  }
  expect(slow.dropped).toBe(true)
  expect(fast.dropped).toBe(false)
  expect(await slow.next(1000)).toBeNull() // its backlog was discarded
  expect(bus.subscriberCount).toBe(1)
})

test("close ends every subscription", async () => {
  const bus = new Bus()
  const sub = bus.subscribe()
  bus.close()
  expect(await sub.next(1000)).toBeNull()
  expect(sub.dropped).toBe(false)
  expect(await bus.subscribe().next(1000)).toBeNull()
  bus.publishMeta(meta(S1)) // dropped, no error
})

test("closed subscription is removed", () => {
  const bus = new Bus()
  const sub = bus.subscribe()
  sub.close()
  expect(bus.subscriberCount).toBe(0)
})

test("a type filter drops other types and live events before they are queued", async () => {
  const bus = new Bus({ queueSize: 3 })
  const sub = bus.subscribe(null, { types: new Set(["session.updated", "company.updated"]) })
  for (let i = 0; i < 10; i++) {
    // would overflow a 3-item queue if they were queued and filtered later
    bus.publishLive(live(S1))
    bus.publishMeta(meta(S1, "profile.updated"))
  }
  const keep = meta("0123abc", "company.updated", { sha: "0123abc" })
  bus.publishMeta(keep)
  expect(await sub.next(1000)).toEqual(["meta", keep])
  expect(sub.dropped).toBe(false)
  expect(bus.subscriberCount).toBe(1)
})

test("without types a subscription still takes everything", async () => {
  const bus = new Bus()
  const sub = bus.subscribe()
  const a = live(S1)
  const b = meta(S1, "profile.updated")
  bus.publishLive(a)
  bus.publishMeta(b)
  expect([await sub.next(1000), await sub.next(1000)]).toEqual([["live", a], ["meta", b]])
})

test("types given as one string is a type error", () => {
  const bus = new Bus()
  // would otherwise be a set of its characters and match nothing
  expect(() => bus.subscribe(null, { types: "company.updated" })).toThrow(TypeError)
  expect(bus.subscriberCount).toBe(0)
})

test("end wakes a waiting next and removes the subscription", async () => {
  const bus = new Bus()
  const sub = bus.subscribe()
  const waiting = sub.next(5000)
  await Promise.resolve()
  sub.end()
  expect(await waiting).toBeNull()
  expect(bus.subscriberCount).toBe(0)
})

test("a burst overflows a full queue before a waiting reader runs", async () => {
  const bus = new Bus({ queueSize: 3 })
  const sub = bus.subscribe()
  const waiting = sub.next(5000)
  for (let i = 0; i < 5; i++) bus.publishLive(live(S1, String(i)))
  expect(await waiting).toBeNull()
  expect(sub.dropped).toBe(true)
  expect(bus.subscriberCount).toBe(0)
})

test("a second reader while one waits is refused", async () => {
  const bus = new Bus()
  const sub = bus.subscribe()
  const first = sub.next(5000)
  await expect(sub.next(5000)).rejects.toThrow("a subscription has one reader at a time")
  bus.publishLive(live(S1, "a"))
  expect(text(await first)).toBe("a")
})

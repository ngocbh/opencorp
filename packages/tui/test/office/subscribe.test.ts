import { afterEach, expect, test } from "bun:test"
import { createFakeOffice, serveUnix } from "../../script/stub"
import { createOfficeClient } from "../../src/office/client"
import { subscribe, type StreamEvent, type SubscribeOptions } from "../../src/office/sse"
import { until } from "../fixture/until"

const fast = { minDelayMs: 10, maxDelayMs: 40 }
const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((f) => f()))

function watch(socket: string, opts: SubscribeOptions = {}) {
  const seen: StreamEvent[] = []
  const sub = subscribe(socket, (e) => seen.push(e), { ...fast, ...opts })
  cleanup.push(sub.close)
  return { seen, types: () => seen.map((e) => e.type), sub }
}
const fake = () => {
  const o = createFakeOffice()
  cleanup.push(o.stop)
  return o
}
const connects = (w: ReturnType<typeof watch>) => w.types().filter((x) => x === "connected").length

test("connected, then typed meta and live events; pings are silent", async () => {
  const office = fake()
  const w = watch(office.socket)
  await until(() => w.types().includes("connected"))
  const s = office.state.sessions[0]
  office.emit({ id: "01E", type: "session.updated", at: s.updated_at, subject_id: s.id, data: { ...s } })
  office.ping()
  office.live({ type: "part.delta", session_id: s.id, data: { message_id: "m", part_id: "p", text: "x" } })
  await until(() => w.seen.length === 3)
  expect(w.seen[1]).toMatchObject({ type: "meta", id: "01E", event: { type: "session.updated" } })
  expect(w.seen[2]).toMatchObject({ type: "live", event: { type: "part.delta" } })
})

test("a malformed frame and an unknown event name are skipped", async () => {
  const body =
    ": connected\n\nevent: meta\ndata: {nope\n\nevent: other\ndata: {}\n\n" +
    'event: live\ndata: {"type":"part.delta","session_id":"s","data":{}}\n\n'
  const srv = serveUnix(() => new Response(body))
  cleanup.push(srv.stop)
  const w = watch(srv.socket)
  await until(() => w.types().includes("live"))
  expect(w.types().slice(0, 2)).toEqual(["connected", "live"])
})

test("reset: disconnected, then reconnected at once", async () => {
  const office = fake()
  const w = watch(office.socket, { minDelayMs: 1000 }) // a normal disconnect would wait 1 s
  await until(() => w.types().includes("connected"))
  const t = Date.now()
  office.reset()
  await until(() => connects(w) === 2)
  expect(Date.now() - t).toBeLessThan(500)
  expect(w.types()).toEqual(["connected", "disconnected", "connected"])
})

test("a ': dropped' comment is a reset too", async () => {
  const office = fake()
  const w = watch(office.socket, { minDelayMs: 1000 })
  await until(() => w.types().includes("connected"))
  office.comment("dropped")
  await until(() => connects(w) === 2, 500)
})

test("a closed stream reconnects with backoff", async () => {
  const office = fake()
  const w = watch(office.socket)
  await until(() => w.types().includes("connected"))
  office.dropStreams()
  await until(() => connects(w) === 2)
})

test("no office at first: one unreachable, then connected once it starts", async () => {
  const socket = `/tmp/act-late-${process.pid}.sock`
  const w = watch(socket)
  await Bun.sleep(100)
  expect(w.types()).toEqual(["unreachable"]) // retries don't repeat it
  const office = createFakeOffice({ socket })
  cleanup.push(office.stop)
  await until(() => w.types().includes("connected"))
})

test("ping timeout: silence past idleMs is a dead stream", async () => {
  let connections = 0
  const srv = serveUnix(() => {
    connections++
    return new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode(": connected\n\n")) }))
  })
  cleanup.push(srv.stop)
  const w = watch(srv.socket, { idleMs: 100 })
  await until(() => connections >= 2, 1500)
  await until(() => connects(w) >= 2)
  expect(w.types().slice(0, 3)).toEqual(["connected", "disconnected", "connected"])
})

test("pings keep a quiet stream alive", async () => {
  const office = fake()
  // Pings every 40 ms against a 300 ms idle limit: a slow tick can't fake a dead stream.
  const w = watch(office.socket, { idleMs: 300 })
  await until(() => w.types().includes("connected"))
  for (let i = 0; i < 16; i++) (office.ping(), await Bun.sleep(40))
  expect(w.types()).toEqual(["connected"])
})

test("close stops reconnecting; ?session= is sent", async () => {
  const office = fake()
  const w = watch(office.socket, { session: "S1" })
  await until(() => w.types().includes("connected"))
  expect(office.requests.at(-1)?.raw).toBe("/events?session=S1")
  w.sub.close()
  office.dropStreams()
  await Bun.sleep(100)
  expect(office.streams()).toBe(0)
  expect(w.types()).toEqual(["connected"])
})

test("the client exposes the subscription", async () => {
  const office = fake()
  const seen: string[] = []
  const sub = createOfficeClient({ socket: office.socket }).events.subscribe((e) => seen.push(e.type), fast)
  cleanup.push(sub.close)
  await until(() => seen.includes("connected"))
})

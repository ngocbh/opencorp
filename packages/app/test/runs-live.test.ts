import { expect, test } from "bun:test"
import type { RunLiveFrame } from "@opencorp/client"
import { applyLive, liveFollow, shownCalls, type LiveCall } from "../src/runs/live"

const apply = (frames: RunLiveFrame[], calls: LiveCall[] = []) => frames.reduce(applyLive, calls)
const start = (node: string, n: number): RunLiveFrame => ({
  type: "start",
  node,
  n,
  model: null,
  purpose: "reply",
  started_at: "2026-10-26T00:00:00Z",
})
const chunk = (node: string, n: number, index: number, text: string): RunLiveFrame => ({
  type: "chunk",
  node,
  n,
  index,
  text,
})

test("a started call is empty and its chunks append in order", () => {
  const calls = apply([start("a", 0), chunk("a", 0, 0, "Hel"), chunk("a", 0, 1, "lo")])
  expect(calls).toEqual([{ node: "a", n: 0, text: "Hello", next: 2, ended: false, error: null }])
})

test("a merged chunk carries its last index, so the next chunk follows it", () => {
  const calls = apply([start("a", 0), chunk("a", 0, 2, "abc"), chunk("a", 0, 3, "d")])
  expect(calls[0]).toMatchObject({ text: "abcd", next: 4 })
})

test("a chunk below the next index is a repeat and is dropped", () => {
  const calls = apply([start("a", 0), chunk("a", 0, 0, "x"), chunk("a", 0, 0, "x")])
  expect(calls[0]).toMatchObject({ text: "x", next: 1 })
})

test("a call frame sets the text so far and the next index", () => {
  const calls = apply([
    { type: "call", node: "a", n: 1, text: "so far", next_index: 5 },
    chunk("a", 1, 4, "old"),
    chunk("a", 1, 5, "!"),
  ])
  expect(calls[0]).toMatchObject({ n: 1, text: "so far!", next: 6 })
})

test("calls are kept apart by node and number, and end with their error", () => {
  const calls = apply([
    start("a", 0),
    start("b", 0),
    start("a", 1),
    chunk("b", 0, 0, "B"),
    chunk("a", 1, 0, "A1"),
    { type: "end", node: "a", n: 1, error: "timed out" },
  ])
  expect(calls.map((c) => [c.node, c.n, c.text, c.ended, c.error])).toEqual([
    ["a", 0, "", false, null],
    ["b", 0, "B", false, null],
    ["a", 1, "A1", true, "timed out"],
  ])
})

test("a node shows only its calls with text that is not blank", () => {
  const calls = apply([
    start("a", 0),
    start("a", 1),
    chunk("a", 1, 0, "  \n"),
    start("a", 2),
    chunk("a", 2, 0, "yes"),
    start("b", 0),
    chunk("b", 0, 0, "no"),
  ])
  expect(shownCalls(calls, "a").map((c) => c.text)).toEqual(["yes"])
  expect(shownCalls(calls, "c")).toEqual([])
})

/** A fake stream opener: each open is recorded with its `after`, its handler and whether it was closed. */
function opener() {
  const opens: { after: number | undefined; send: (f: RunLiveFrame) => void; closed: boolean }[] = []
  const open = (after: number | undefined, send: (f: RunLiveFrame) => void) => {
    const o = { after, send, closed: false }
    opens.push(o)
    return { close: () => void (o.closed = true) }
  }
  return { opens, open }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function follow() {
  const { opens, open } = opener()
  const records: number[] = []
  let calls: LiveCall[] = []
  const live = liveFollow({
    open,
    onRecord: (seq) => records.push(seq),
    onCalls: (c) => (calls = c),
    minDelayMs: 20,
    maxDelayMs: 40,
  })
  return { opens, records, calls: () => calls, live }
}

test("a stream opens only while the run is running, after the highest seq seen", () => {
  const { opens, live } = follow()
  live.seen(3)
  live.status("waiting")
  expect(opens).toEqual([])
  live.status("running")
  live.status("running")
  expect(opens.map((o) => o.after)).toEqual([3])
  live.dispose()
})

test("with no seq seen the stream opens without after", () => {
  const { opens, live } = follow()
  live.status("running")
  expect(opens[0]!.after).toBeUndefined()
  live.dispose()
})

test("record frames raise the highest seq and are passed on; call frames fill the live calls", () => {
  const { opens, records, calls, live } = follow()
  live.status("running")
  opens[0]!.send({ type: "record", seq: 8, record: { seq: 8, kind: "node_started" } })
  opens[0]!.send(start("a", 0))
  opens[0]!.send(chunk("a", 0, 0, "hi"))
  expect(records).toEqual([8])
  expect(shownCalls(calls(), "a").map((c) => c.text)).toEqual(["hi"])
  opens[0]!.send({ type: "reset" })
  expect(calls()).toEqual([])
  expect(opens.map((o) => o.after)).toEqual([undefined, 8])
  live.dispose()
})

test("a reset reopens at once; a second reset in a row waits", async () => {
  const { opens, live } = follow()
  live.status("running")
  opens[0]!.send({ type: "reset" })
  expect(opens.length).toBe(2)
  opens[1]!.send({ type: "reset" })
  expect(opens.length).toBe(2)
  await sleep(30)
  expect(opens.length).toBe(3)
  live.dispose()
})

test("after run_end a run still running is retried after a delay that doubles", async () => {
  const { opens, live } = follow()
  live.status("running")
  opens[0]!.send({ type: "run_end" })
  expect(opens.length).toBe(1)
  await sleep(30)
  expect(opens.length).toBe(2)
  opens[1]!.send({ type: "run_end" })
  await sleep(30)
  expect(opens.length).toBe(2)
  await sleep(20)
  expect(opens.length).toBe(3)
  live.dispose()
})

test("after run_end a run.updated showing running reopens at once", () => {
  const { opens, live } = follow()
  live.status("running")
  opens[0]!.send({ type: "run_end" })
  live.status("running")
  expect(opens.length).toBe(2)
  live.dispose()
})

test("a run that stopped running is not retried", async () => {
  const { opens, live } = follow()
  live.status("running")
  opens[0]!.send({ type: "closed", error: new Error("gone") })
  live.status("finished")
  await sleep(50)
  expect(opens.length).toBe(1)
  live.dispose()
})

test("frames from a stream that ended are ignored", () => {
  const { opens, records, live } = follow()
  live.status("running")
  const first = opens[0]!
  first.send({ type: "reset" })
  first.send({ type: "record", seq: 1, record: { seq: 1, kind: "x" } })
  expect(records).toEqual([])
  live.dispose()
})

test("dispose closes the stream and stops for good", async () => {
  const { opens, live } = follow()
  live.status("running")
  live.dispose()
  expect(opens[0]!.closed).toBe(true)
  live.status("running")
  await sleep(30)
  expect(opens.length).toBe(1)
})

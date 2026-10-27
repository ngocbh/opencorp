import { afterEach, expect, test } from "bun:test"
import { createOfficeClient } from "../src/client"
import { OfficeError } from "../src/errors"
import { createParser, type RunLiveFrame, type SseMessage } from "../src/sse"
import { serve, stopServers } from "./serve"

afterEach(stopServers)

function parse(chunks: (string | Uint8Array)[]) {
  const messages: SseMessage[] = []
  const comments: string[] = []
  const p = createParser(
    (m) => messages.push(m),
    (c) => comments.push(c),
  )
  for (const c of chunks) p.feed(typeof c === "string" ? new TextEncoder().encode(c) : c)
  return { messages, comments }
}

const frame = ': connected\n\nevent: meta\nid: 01A\ndata: {"a":1}\n\nevent: live\ndata: {"b":2}\n\n: ping\n\n'

test("parses events, ids, and comments", () => {
  expect(parse([frame])).toEqual({
    messages: [
      { event: "meta", id: "01A", data: '{"a":1}' },
      { event: "live", data: '{"b":2}' },
    ],
    comments: ["connected", "ping"],
  })
})

test("chunks split at every byte give the same result", () => {
  const bytes = new TextEncoder().encode(frame)
  expect(parse([...bytes].map((b) => new Uint8Array([b])))).toEqual(parse([frame]))
})

test("a multi-byte character split across chunks survives", () => {
  const bytes = new TextEncoder().encode('event: live\ndata: {"t":"é"}\n\n')
  const cut = bytes.indexOf(0xc3) + 1
  expect(parse([bytes.slice(0, cut), bytes.slice(cut)]).messages[0].data).toBe('{"t":"é"}')
})

test("CRLF lines, multi-line data, no space after the colon, and data-less blocks", () => {
  const { messages } = parse(["event:x\r\ndata: a\r\ndata:b\r\n\r\nevent: y\n\n"])
  expect(messages).toEqual([{ event: "x", data: "a\nb" }])
})

test("an empty data field still dispatches, as the office's reset frame relies on", () => {
  expect(parse(["event: reset\ndata:\n\n"]).messages).toEqual([{ event: "reset", data: "" }])
})

const record = { seq: 4, kind: "node_started", node_id: "a", payload: {}, cut: [] }
const live = [
  ": connected\n\n",
  `event: record\ndata: ${JSON.stringify({ seq: 4, record })}\n\n`,
  `event: call\ndata: ${JSON.stringify({ node: "a", n: 0, text: "He", next_index: 2 })}\n\n`,
  `event: start\ndata: ${JSON.stringify({ node: "a", n: 1, model: null, purpose: "reply", started_at: "t" })}\n\n`,
  `event: chunk\ndata: ${JSON.stringify({ node: "a", n: 0, index: 2, text: "llo" })}\n\n`,
  ": ping\n\n",
  `event: end\ndata: ${JSON.stringify({ node: "a", n: 0, error: null })}\n\n`,
  "event: run_end\ndata: {}\n\n",
]

/** An SSE answer that writes `parts` one read at a time, and stays open after them unless `end`. */
function sse(parts: string[], end = true) {
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      const part = parts.shift()
      if (part !== undefined) return c.enqueue(new TextEncoder().encode(part))
      if (end) c.close()
      else await new Promise(() => {})
    },
  })
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

/** Reads run R1's live stream from a server answering `answer`, until it ends. */
function readLive(answer: () => Response, after?: number) {
  const server = serve({ answer })
  const frames: RunLiveFrame[] = []
  const done = new Promise<void>((resolve) => {
    createOfficeClient({ baseUrl: server.base }).runs.live(
      "R1",
      (f) => {
        frames.push(f)
        if (f.type === "run_end" || f.type === "reset" || f.type === "closed") resolve()
      },
      { after },
    )
  })
  return { server, frames, done }
}

test("a run live stream gives its frames in order, a frame split across reads included", async () => {
  const whole = live.join("")
  const cut = whole.indexOf('"llo"') + 2
  const { server, frames, done } = readLive(() => sse([whole.slice(0, cut), whole.slice(cut)]))
  await done
  expect(server.seen[0]).toMatchObject({ method: "GET", path: "/api/runs/R1/live", query: "" })
  expect(frames).toEqual([
    { type: "record", seq: 4, record },
    { type: "call", node: "a", n: 0, text: "He", next_index: 2 },
    { type: "start", node: "a", n: 1, model: null, purpose: "reply", started_at: "t" },
    { type: "chunk", node: "a", n: 0, index: 2, text: "llo" },
    { type: "end", node: "a", n: 0, error: null },
    { type: "run_end" },
  ])
})

test("a run live stream sends after as a query", async () => {
  const { server, done } = readLive(() => sse(["event: reset\ndata:\n\n"]), 7)
  await done
  expect(server.seen[0]!.query).toBe("?after=7")
})

test("unknown events and malformed data are skipped", async () => {
  const { frames, done } = readLive(() =>
    sse([
      'event: later\ndata: {"node":"a"}\n\n',
      "event: chunk\ndata: not json\n\n",
      'event: chunk\ndata: {"node":"a","n":0,"index":"1","text":"x"}\n\n',
      'event: end\ndata: {"node":"a","n":0,"error":null}\n\n',
      "event: reset\ndata:\n\n",
    ]),
  )
  await done
  expect(frames).toEqual([{ type: "end", node: "a", n: 0, error: null }, { type: "reset" }])
})

test("a stream that ends without run_end or reset is closed", async () => {
  const { frames, done } = readLive(() => sse([": connected\n\n"]))
  await done
  expect(frames).toEqual([{ type: "closed" }])
})

test("a 404 is closed with an OfficeError carrying the office code", async () => {
  const { frames, done } = readLive(() =>
    Response.json({ error: "no_log", message: "this run has no log" }, { status: 404 }),
  )
  await done
  const [f] = frames
  expect(f?.type).toBe("closed")
  const error = (f as { error?: unknown }).error
  expect(error).toBeInstanceOf(OfficeError)
  expect(error).toMatchObject({ status: 404, code: "no_log" })
})

test("close stops a stream, which reports nothing more", async () => {
  let opened!: () => void
  const started = new Promise<void>((r) => (opened = r))
  const server = serve({
    answer: () => {
      opened()
      return sse([": connected\n\n"], false)
    },
  })
  const frames: RunLiveFrame[] = []
  const stream = createOfficeClient({ baseUrl: server.base }).runs.live("R1", (f) => frames.push(f))
  await started
  stream.close()
  await new Promise((r) => setTimeout(r, 50))
  expect(frames).toEqual([])
})

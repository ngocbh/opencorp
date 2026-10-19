import { expect, test } from "bun:test"
import { createParser, type SseMessage } from "../src/sse"

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

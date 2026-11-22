/** Claude Code's stream-json stdio, over in-memory pipes: control requests and their answers, Claude Code's own
 *  requests, every other line, and what ends the stream. */
import { PassThrough } from "node:stream"
import { expect, test } from "bun:test"
import { ControlError, MAX_LINE, type Msg, StreamClosed, StreamJson } from "../../../src/tools/claude/stream.ts"

/** A stream over in-memory pipes: what the office wrote, what reached each handler, and a way to write as Claude
 *  Code. */
function pipes() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const written: Msg[] = []
  stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) written.push(JSON.parse(line))
  })
  const messages: Msg[] = []
  const requests: [string, Msg][] = []
  const logged: string[] = []
  let closed = 0
  let killed = 0
  const stream = new StreamJson(stdin, stdout, {
    onMessage: (msg) => messages.push(msg),
    onRequest: (id, request) => requests.push([id, request]),
    onClosed: () => closed++,
    kill: () => killed++,
    log: (line) => logged.push(line),
  })
  stream.start()
  const write = (msg: Msg | string) => stdout.write((typeof msg === "string" ? msg : JSON.stringify(msg)) + "\n")
  return { stream, stdin, stdout, written, messages, requests, logged, write, closed: () => closed, killed: () => killed }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

test("a control request resolves with its answer's response, and an error answer rejects with Claude Code's words", async () => {
  const p = pipes()
  const init = p.stream.request("initialize", { hooks: {} })
  await tick()
  const [sent] = p.written
  expect(sent).toMatchObject({ type: "control_request", request: { subtype: "initialize", hooks: {} } })
  const id = sent!.request_id as string
  p.write({ type: "control_response", response: { subtype: "success", request_id: "someone-else", response: {} } })
  p.write({ type: "control_response", response: { subtype: "success", request_id: id, response: { pid: 7 } } })
  expect(await init).toEqual({ pid: 7 })
  const bare = p.stream.request("interrupt")
  await tick()
  p.write({ type: "control_response", response: { subtype: "success", request_id: p.written[1]!.request_id } })
  expect(await bare).toEqual({})
  const refused = p.stream.request("set_model", { model: "x" })
  await tick()
  p.write({ type: "control_response", response: { subtype: "error", request_id: p.written[2]!.request_id, error: "no" } })
  const e = await refused.catch((error: Error) => error)
  expect(e).toBeInstanceOf(ControlError)
  expect((e as Error).message).toBe("no")
  expect(p.messages).toEqual([])
})

test("Claude Code's own requests go to their handler and are answered by id; every other line to the message handler", async () => {
  const p = pipes()
  p.write({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash" } })
  p.write({ type: "system", subtype: "init" })
  p.write({ type: "control_cancel_request", request_id: "r1" })
  await tick()
  expect(p.requests).toEqual([["r1", { subtype: "can_use_tool", tool_name: "Bash" }]])
  expect(p.messages.map((m) => m.type)).toEqual(["system", "control_cancel_request"])
  await p.stream.answer("r1", { behavior: "deny", message: "no" })
  await p.stream.refuse("r2", "unsupported")
  expect(p.written).toEqual([
    { type: "control_response", response: { subtype: "success", request_id: "r1", response: { behavior: "deny", message: "no" } } },
    { type: "control_response", response: { subtype: "error", request_id: "r2", error: "unsupported" } },
  ])
})

test("a line that isn't a JSON object is logged cut short and skipped", async () => {
  const p = pipes()
  p.write("not json " + "x".repeat(500))
  p.write("[1, 2]")
  p.write({ type: "assistant" })
  await tick()
  expect(p.messages).toEqual([{ type: "assistant" }])
  expect(p.logged).toHaveLength(2)
  expect(p.logged[0]!.length).toBeLessThan(300)
})

test("the end of stdout fails what waits and closes once; later requests and writes reject", async () => {
  const p = pipes()
  const waiting = p.stream.request("initialize")
  p.stdout.end()
  expect(await waiting.catch((error: Error) => error)).toBeInstanceOf(StreamClosed)
  await tick()
  expect(p.closed()).toBe(1)
  expect(await p.stream.request("interrupt").catch((error: Error) => error)).toBeInstanceOf(StreamClosed)
  p.stdin.end()
  expect(await p.stream.send({ type: "user" }).catch((error: Error) => error)).toBeInstanceOf(StreamClosed)
})

test("a line over the cap stops Claude Code once and fails what waits", async () => {
  const p = pipes()
  const waiting = p.stream.request("initialize")
  p.stdout.write(Buffer.alloc(MAX_LINE + 1, 0x61))
  expect(await waiting.catch((error: Error) => error)).toBeInstanceOf(StreamClosed)
  expect([p.killed(), p.closed()]).toEqual([1, 1])
})

test("a request with no answer times out", async () => {
  const p = pipes()
  const e = await p.stream.request("initialize", {}, { timeout: 20 }).catch((error: Error) => error)
  expect(e.name).toBe("TimeoutError")
})

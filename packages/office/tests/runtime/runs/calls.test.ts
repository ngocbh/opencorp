/** A run's model calls through yian's reader, in the protocol's shape: listed per node, one rebuilt with its request,
 *  attempts, reply and tool results, ints as numbers, no provider data, long strings cut and named. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, expect, test } from "bun:test"
import type { AgentCallView } from "@ngocbh/yian/run"
import { RunCall } from "@opencorp/protocol"
import { CALL_TEXT_CHARS, callWire, hasCall, nodeCalls, readCall } from "../../../src/runtime/runs/calls.ts"
import { FakeLLM } from "../../../src/testing/fake_llm.ts"
import { failedRun, gatedRun, interruptedRun, RUN_HEADER, RUN_KEY, RUN_ORG } from "./helpers.ts"

const RECORDED = "01JA1H00000000000000000C01"
const CUT_OFF = "01JA1H00000000000000000C02"
const FAILED = "01JA1H00000000000000000C03"
const FOLD = { env: () => undefined, codeRoot: null }

let dir: string
let gated: string
let interrupted: string
let failed: string
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-calls-"))
  const fake = await FakeLLM.start()
  try {
    gated = await gatedRun(fake, dir, RECORDED)
    interrupted = await interruptedRun(fake, dir, CUT_OFF)
    failed = await failedRun(fake, dir, FAILED)
  } finally {
    await fake.close()
  }
}, 30_000)
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

test("a node's calls are listed oldest first, a retried call once with its attempts", () => {
  const call = (n: number, attempts: number, finish: string) => ({
    node_id: "writer",
    n,
    purpose: "chat",
    model: "stub",
    started_at: expect.any(String),
    attempts,
    finish,
  })
  expect(nodeCalls(gated, "writer")).toEqual([call(1, 1, "tool_calls"), call(8, 2, "stop")])
  expect(nodeCalls(gated, "reply")).toEqual([])
  // Either attempt names the retried call; a step between calls names none.
  expect([7, 8, 1, 2, 6, 9].map((n) => hasCall(gated, "writer", n))).toEqual([true, true, true, false, false, false])
})

test("a rebuilt call holds the request, the reply and each tool call's result with the gate's notes", async () => {
  const call = RunCall.parse(await readCall(gated, "writer", 1, FOLD))
  expect(call.request).toMatchObject({
    model: "stub",
    params: { provider: "vllm", model: "stub" },
    system: "Be exact.",
    messages: [{ role: "user", author: null, parts: [{ type: "text", text: "Write about owls." }] }],
  })
  expect(call.request!.tools.map((tool) => tool.name)).toEqual(["lookup", "save", "wipe"])
  expect(call.reply!.parts.map((part) => part.type)).toEqual(["tool_call", "tool_call", "tool_call"])
  expect(call.tool_results.map(({ name, output, closed, note, held, release_note }) => ({
    name, output, closed, note, held, release_note,
  }))).toEqual([
    { name: "lookup", output: "lookup:owls", closed: null, note: "read-only", held: false, release_note: null },
    { name: "save", output: "save:owls", closed: null, note: null, held: true, release_note: "approved by @ngocbh" },
    { name: "wipe", output: "Not run: a deny rule: wipe *.", closed: "refused", note: null, held: false, release_note: null },
  ])
  expect(call).toMatchObject({ finish: "tool_calls", interrupted: false, digest_mismatch: false, cut: [] })
  // As JSON: no provider data, and never the run's key or the header value sent with it.
  const text = JSON.stringify(call)
  expect([text.includes("provider_payload"), text.includes(RUN_KEY), text.includes(RUN_HEADER)]).toEqual([false, false, false])
})

test("a retried call shows each attempt, the failed one's error and wait", async () => {
  const call = await readCall(gated, "writer", 7, FOLD)
  expect(call.n).toBe(8)
  expect(call.attempts.map(({ n, error, retry_in }) => ({ n, kind: error?.kind ?? null, waited: retry_in !== null })))
    .toEqual([{ n: 7, kind: "incomplete", waited: true }, { n: 8, kind: null, waited: false }])
  expect(call.reply).toEqual({ role: "assistant", author: null, parts: [{ type: "text", text: "Done." }] })
  expect(call.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 })
  // The request carries the three results the model read.
  expect(call.request!.messages.filter((m) => m.role === "tool")).toHaveLength(3)
})

test("an interrupted call says so, with what arrived before the cut", async () => {
  const call = await readCall(interrupted, "reply", 1, FOLD)
  expect(call).toMatchObject({ finish: "interrupted", interrupted: true })
  expect(call.request!.system).toBe("Help.")
})

test("a failed call shows its endpoint and organization, never the key or the header sent with it", async () => {
  const call = await readCall(failed, "reply", 1, FOLD)
  expect(call).toMatchObject({ finish: null, reply: null })
  expect(call.attempts.map((attempt) => attempt.error !== null)).toEqual([true])
  expect(call.request!.params).toMatchObject({ provider: "openai", organization: RUN_ORG, base_url: expect.any(String) })
  const text = JSON.stringify(call)
  expect([text.includes(RUN_KEY), text.includes(RUN_HEADER), text.includes("x-team-token")]).toEqual([false, false, false])
})

/** A view with `over`, as yian's `agentCall` returns one. */
function view(over: Partial<AgentCallView> = {}): AgentCallView {
  return {
    nodeId: "a",
    n: 1,
    purpose: "chat",
    request: null,
    digestMismatch: false,
    attempts: [],
    reply: null,
    toolResults: [],
    usage: null,
    finish: "stop",
    interrupted: false,
    ...over,
  }
}

test("a string over the limit is cut with an ellipsis and named, never through a surrogate pair", () => {
  const long = "x".repeat(CALL_TEXT_CHARS + 5)
  const pair = `${"y".repeat(CALL_TEXT_CHARS - 1)}😀z`
  const call = callWire(view({
    reply: { role: "assistant", parts: [{ type: "text", text: long }, { type: "text", text: pair }] },
    toolResults: [{
      callId: "c/1", name: "t", arguments: { "a/b~": long }, output: "short", isError: false, closed: null,
      startedAt: null, note: null, held: false, releaseNote: null,
    }],
  }))
  expect(call.cut).toEqual(["/reply/parts/0/text", "/reply/parts/1/text", "/tool_results/0/arguments/a~1b~0"])
  const [first, second] = call.reply!.parts as { text: string }[]
  expect([first!.text.length, first!.text.endsWith("…")]).toEqual([CALL_TEXT_CHARS + 1, true])
  expect(second!.text).toBe(`${"y".repeat(CALL_TEXT_CHARS - 1)}…`)
  expect(call.tool_results![0]!.output).toBe("short")
})

test("yian's ints are numbers, or their digits past the safe integers", () => {
  const call = callWire(view({
    toolResults: [{
      callId: "c", name: "t", arguments: { count: 5n as unknown as number, huge: (2n ** 60n) as unknown as number },
      output: null, isError: null, closed: null, startedAt: null, note: null, held: false, releaseNote: null,
    }],
  }))
  expect(call.tool_results![0]!.arguments).toEqual({ count: 5, huge: "1152921504606846976" })
})

test("a person's action the model read shows as the line it read, its ints as numbers", () => {
  const action = {
    type: "action" as const,
    tool: "terminal_type",
    summary: "Ada typed into shell 1",
    arguments: { shell: "shell 1", lines: 2n as unknown as number },
    result: null,
  }
  const call = callWire(view({
    request: {
      model: "stub", params: {}, system: null, tools: [], toolChoice: null, parallelToolCalls: null, outputFormat: null,
      messages: [{ role: "user", author: "Ada", parts: [action, { type: "text", text: "and this" }] }],
    },
  }))
  expect(call.request!.messages).toEqual([{
    role: "user",
    author: "Ada",
    parts: [
      { type: "text", text: 'action: {"tool":"terminal_type","summary":"Ada typed into shell 1","arguments":{"shell":"shell 1","lines":2}}' },
      { type: "text", text: "and this" },
    ],
  }])
  expect(RunCall.safeParse(call).success).toBe(true)
})

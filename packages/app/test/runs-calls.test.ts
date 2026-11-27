import { expect, test } from "bun:test"
import type { RunCallEntry, RunCallToolCall, RunCallToolResult } from "@opencorp/protocol"
import {
  argsLine,
  callLine,
  callParts,
  cutAt,
  finishText,
  FOLD_CHARS,
  FOLD_LINES,
  foldedHead,
  gateLines,
  hiddenReasoning,
  outcomeText,
  pointer,
  seconds,
  toolLine,
  toolState,
  usageText,
  wentWrong,
} from "../src/runs/calls"

const entry = (over: Partial<RunCallEntry> = {}): RunCallEntry => ({
  node_id: "chat#2/reply", n: 4, purpose: "chat", model: "gpt-5", started_at: "2026-10-20T10:00:00.000Z",
  attempts: 1, finish: "stop", ...over,
})

const result = (over: Partial<RunCallToolResult> = {}): RunCallToolResult => ({
  call_id: "c1", name: "save", arguments: { topic: "owls" }, output: "saved", is_error: false, closed: null,
  started_at: null, note: null, held: false, release_note: null, ...over,
})

test("a listed call names its place among the node's calls, never its step, then its model, finish and retries", () => {
  // Step 4 of the node, its second model call: tool results and retried attempts take step numbers too.
  expect(callLine(entry(), 2)).toBe("Call 2 · gpt-5 · replied")
  expect(callLine(entry({ attempts: 3, finish: "tool_calls" }), 1)).toBe("Call 1 · gpt-5 · asked for tools · 3 attempts")
  expect(callLine(entry({ finish: null }), 3)).toBe("Call 3 · gpt-5 · failed")
  expect(callLine(entry({ purpose: "structured_native" }), 1)).toBe("Call 1 · gpt-5 · replied · structured_native")
  // The finish's raw value is its part's title; a failed call has none.
  expect(callParts(entry({ finish: "tool_calls" }), 1)).toEqual([
    { text: "Call 1" },
    { text: "gpt-5" },
    { text: "asked for tools", title: "tool_calls" },
  ])
  expect(callParts(entry({ finish: null }), 1)[2]).toEqual({ text: "failed" })
})

test("a finish reason reads in plain words, and any other provider text as it is", () => {
  expect(finishText("stop")).toBe("replied")
  expect(finishText("tool_calls")).toBe("asked for tools")
  expect(finishText("length")).toBe("cut off at the token limit")
  expect(finishText("content_filter")).toBe("refused by the provider")
  expect(finishText("interrupted")).toBe("interrupted")
  expect(finishText(null)).toBe("failed")
  expect(finishText(undefined)).toBe("failed")
  expect(finishText("end_turn")).toBe("end_turn")
})

test("a long text folds to its first lines, at most so many characters; a short one shows whole", () => {
  expect(foldedHead("short")).toBeNull()
  const lines = Array.from({ length: FOLD_LINES + 3 }, (_, i) => `line ${i}`).join("\n")
  expect(foldedHead(lines)).toBe(lines.split("\n").slice(0, FOLD_LINES).join("\n"))
  const wide = "w".repeat(FOLD_CHARS + 10)
  expect(foldedHead(wide)).toBe("w".repeat(FOLD_CHARS))
  // Never half of a surrogate pair.
  expect(foldedHead(`${"x".repeat(FOLD_CHARS - 1)}😀 and more`)).toBe("x".repeat(FOLD_CHARS - 1))
})

test("a cut string is found by its pointer or under it", () => {
  const call = { cut: ["/request/messages/2/parts/0/text", "/tool_results/0/arguments/a~1b"] }
  expect(pointer("request", "messages", 2, "parts", 0, "text")).toBe("/request/messages/2/parts/0/text")
  expect(pointer("a/b", "c~d")).toBe("/a~1b/c~0d")
  expect(cutAt(call, pointer("request", "messages", 2, "parts", 0, "text"))).toBe(true)
  expect(cutAt(call, pointer("tool_results", 0, "arguments"))).toBe(true)
  expect(cutAt(call, pointer("tool_results", 0, "output"))).toBe(false)
  expect(cutAt({ cut: [] }, "/request/system")).toBe(false)
})

test("usage says what was reported, and nothing when nothing was", () => {
  const usage = { input_tokens: 1200, output_tokens: 300, cache_read_tokens: 800, cache_creation_tokens: null,
                  reasoning_tokens: 40 }
  expect(usageText(usage)).toBe("1,200 in · 300 out · 800 cached · 40 reasoning")
  expect(usageText({ ...usage, cache_read_tokens: null, reasoning_tokens: null })).toBe("1,200 in · 300 out")
  expect(usageText(null)).toBe("")
})

test("a tool call's state, in the words its listed row uses, and the gate's notes on it", () => {
  expect([toolState(result()), gateLines(result())]).toEqual(["ok", []])
  expect([toolState(result({ note: "read-only" })), gateLines(result({ note: "read-only" }))])
    .toEqual(["ok", ["Allowed: read-only"]])
  const released = result({ held: true, release_note: "approved by @ngocbh" })
  expect([toolState(released), gateLines(released)]).toEqual(["ok", ["Held, then released: approved by @ngocbh"]])
  const answered = result({ held: true, output: "Not run: the user said no: use make", is_error: true })
  expect([toolState(answered), gateLines(answered)]).toEqual(["error", ["Held, then answered without running"]])
  const waiting = result({ held: true, output: null, is_error: null })
  expect([toolState(waiting), gateLines(waiting)]).toEqual(["held", ["Held: waiting for an answer"]])
  // Released, or never held, and no result yet.
  expect(toolState(result({ held: true, release_note: "ok", output: null, is_error: null }))).toBe("pending")
  expect(toolState(result({ output: null, is_error: null }))).toBe("pending")
  const refused = result({ closed: "refused", output: "Not run: a deny rule: rm *.", is_error: true })
  expect([toolState(refused), gateLines(refused)]).toEqual(["refused", ["Refused by the gate"]])
  expect(toolState(result({ closed: "skipped", output: "Not run: interrupted by the user.", is_error: true })))
    .toBe("skipped")
  expect(toolState(result({ closed: "timed_out", output: "Not run: timed out.", is_error: true }))).toBe("timed out")
})

test("a listed tool call's row: its name and how it stands in words, a closer yian wrote in place of the outcome", () => {
  const tool = (outcome: string, closed: string | null = null): RunCallToolCall =>
    ({ name: "run_command", call_id: "c1", outcome, closed, result_n: 3, result_at: "2026-10-20T10:00:02.000Z" })
  expect(["ok", "error", "held", "pending"].map((o) => outcomeText(tool(o)))).toEqual(["ok", "error", "held", "pending"])
  expect(["skipped", "refused", "crashed", "interrupted", "timed_out", "failed"].map((w) => outcomeText(tool("error", w))))
    .toEqual(["skipped", "refused", "crashed", "interrupted", "timed out", "failed"])
  // An outcome or a closer a later yian adds shows as it is.
  expect([outcomeText(tool("deferred")), outcomeText(tool("error", "vanished"))]).toEqual(["deferred", "vanished"])
  expect(toolLine(tool("ok"))).toBe("run_command · ok")
  expect(toolLine(tool("error", "crashed"))).toBe("run_command · crashed")
  // Only an error reads as gone wrong; a hold or a call still running doesn't.
  expect(["ok", "held", "pending", "deferred"].map((o) => wentWrong(tool(o)))).toEqual([false, false, false, false])
  expect([wentWrong(tool("error")), wentWrong(tool("error", "refused"))]).toEqual([true, true])
})

test("arguments in a row are their first string, else their JSON, cut to one short line", () => {
  expect(argsLine({ command: "ls -la", why: "look" })).toBe("ls -la")
  expect(argsLine({ count: 3 })).toBe('{"count":3}')
  expect(argsLine({ text: "a\nb" })).toBe("a b")
  expect(argsLine({ text: "x".repeat(200) })).toBe(`${"x".repeat(79)}…`)
  expect(argsLine(null)).toBe("")
})

test("a wait or a span in seconds", () => {
  expect([seconds(0.47043), seconds(12), seconds(0)]).toEqual(["0.5 s", "12 s", "0 s"])
})

test("a thought with no text says the provider kept it, with the tokens it cost when the call reported them", () => {
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_tokens: null, cache_creation_tokens: null,
                  reasoning_tokens: 1200 }
  expect(hiddenReasoning(usage)).toBe("Reasoned privately (1,200 tokens): the provider didn't share its reasoning")
  expect(hiddenReasoning({ ...usage, reasoning_tokens: 1 })).toBe(
    "Reasoned privately (1 token): the provider didn't share its reasoning")
  for (const none of [{ ...usage, reasoning_tokens: 0 }, { ...usage, reasoning_tokens: null }, null, undefined])
    expect(hiddenReasoning(none)).toBe("The provider didn't share its reasoning")
})

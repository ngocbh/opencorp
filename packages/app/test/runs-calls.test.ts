import { expect, test } from "bun:test"
import type { RunCallEntry, RunCallToolResult } from "@opencorp/protocol"
import {
  argsLine,
  callLine,
  cutAt,
  FOLD_CHARS,
  FOLD_LINES,
  foldedHead,
  gateLines,
  pointer,
  seconds,
  toolState,
  usageText,
} from "../src/runs/calls"

const entry = (over: Partial<RunCallEntry> = {}): RunCallEntry => ({
  node_id: "chat#2/reply", n: 4, purpose: "chat", model: "gpt-5", started_at: "2026-10-20T10:00:00.000Z",
  attempts: 1, finish: "stop", ...over,
})

const result = (over: Partial<RunCallToolResult> = {}): RunCallToolResult => ({
  call_id: "c1", name: "save", arguments: { topic: "owls" }, output: "saved", is_error: false, closed: null,
  started_at: null, note: null, held: false, release_note: null, ...over,
})

test("a listed call names its step, model and finish, its retries and an interrupt", () => {
  expect(callLine(entry())).toBe("Call 4 · gpt-5 · stop")
  expect(callLine(entry({ attempts: 3, finish: "tool_calls" }))).toBe("Call 4 · gpt-5 · tool_calls · 3 attempts")
  expect(callLine(entry({ finish: null }))).toBe("Call 4 · gpt-5 · failed")
  expect(callLine(entry({ purpose: "structured_native" }))).toBe("Call 4 · gpt-5 · stop · structured_native")
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

test("a tool call's state and the gate's notes on it", () => {
  expect([toolState(result()), gateLines(result())]).toEqual(["ran", []])
  expect([toolState(result({ note: "read-only" })), gateLines(result({ note: "read-only" }))])
    .toEqual(["ran", ["Allowed: read-only"]])
  const released = result({ held: true, release_note: "approved by @ngocbh" })
  expect([toolState(released), gateLines(released)]).toEqual(["ran", ["Held, then released: approved by @ngocbh"]])
  const answered = result({ held: true, output: "Not run: the user said no: use make", is_error: true })
  expect([toolState(answered), gateLines(answered)]).toEqual(["error", ["Held, then answered without running"]])
  const waiting = result({ held: true, output: null, is_error: null })
  expect([toolState(waiting), gateLines(waiting)]).toEqual(["waiting", ["Held: waiting for an answer"]])
  const refused = result({ closed: "refused", output: "Not run: a deny rule: rm *.", is_error: true })
  expect([toolState(refused), gateLines(refused)]).toEqual(["refused", ["Refused by the gate"]])
  expect(toolState(result({ closed: "skipped", output: "Not run: interrupted by the user.", is_error: true })))
    .toBe("skipped")
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

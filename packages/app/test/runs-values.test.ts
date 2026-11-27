import { expect, test } from "bun:test"
import type { RunNodeValue } from "@opencorp/protocol"
import { duration, durationText, nodeOutputs, preview, shownWhole, workOf } from "../src/runs/values"

const value = (v: unknown, over: Partial<RunNodeValue> = {}): RunNodeValue =>
  ({ name: "output", seq: 4, type: null, value: v, missing: null, size: null, cut: [], ...over })

test("a value's preview: a string quoted and cut to its first line, a list by its length, a record by its keys", () => {
  expect(preview(value("Sure, I'll look."))).toBe('"Sure, I\'ll look."')
  expect(preview(value(""))).toBe('""')
  expect(preview(value("first line\nsecond"))).toBe('"first line…"')
  expect(preview(value("a".repeat(100)))).toBe(`"${"a".repeat(60)}…"`)
  expect([preview(value(3)), preview(value(true)), preview(value(null))]).toEqual(["3", "true", "null"])
  expect(preview(value([]))).toBe("[]")
  expect(preview(value(["a", "b"]))).toBe("2 items")
  expect(preview(value([1]))).toBe("1 item")
  const said = { role: "assistant", parts: [{ type: "text", text: "Hi" }] }
  expect(preview(value([said, said, said]))).toBe("3 messages")
  expect(preview(value([said]))).toBe("1 message")
  expect(preview(value({}))).toBe("{}")
  expect(preview(value({ summary: "", history: [] }))).toBe("{summary, history}")
  expect(preview(value(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field_${i}`, i])))))
    .toMatch(/^\{field_0, field_1, .*…\}$/)
})

test("a value that isn't here says why, in the office's words, with its size when it's too large", () => {
  expect(preview(value(null, { missing: "too large to show; download the log", size: 3 * 2 ** 20 }))).toBe(
    "3.0 MB: too large to show; download the log")
  expect(preview(value(null, { missing: "not given" }))).toBe("not given")
  expect(preview(value(null, { missing: "the run's flow doesn't load: x" }))).toBe("the run's flow doesn't load: x")
})

test("a node's outputs are its view's once read, else its detail's, a derived one still being read saying so", () => {
  const derived = value(null, { name: "new_messages", missing: "derived from other values" })
  const detail = [value("Done."), derived]
  expect(nodeOutputs(detail, undefined, true)).toEqual([value("Done."), { ...derived, missing: "reading the log…" }])
  // The view failed: the detail's say why they aren't here.
  expect(nodeOutputs(detail, undefined, false)).toEqual(detail)
  const typed = [value("Done.", { seq: null, type: "Optional(str)" }), value([], { seq: null, type: "list(Message)" })]
  expect(nodeOutputs(detail, typed, false)).toEqual(typed)
  expect(nodeOutputs(undefined, undefined, true)).toEqual([])
})

test("only a value its preview shows whole has nothing to open", () => {
  for (const v of ["short", "", 3, false, null, [], {}]) expect([v, shownWhole(value(v))]).toEqual([v, true])
  for (const v of ["two\nlines", "a".repeat(61), ["a"], { a: 1 }]) expect([v, shownWhole(value(v))]).toEqual([v, false])
  // A string the office cut, however short it shows, opens to say so.
  expect(shownWhole(value("abc", { cut: [""] }))).toBe(false)
  expect(shownWhole(value(null, { missing: "too large to show; download the log", size: 9 }))).toBe(true)
})

test("a duration from two record times, none when either is missing or the clock went back", () => {
  expect(duration("2026-10-20T10:00:00.000Z", "2026-10-20T10:00:00.450Z")).toBe("450ms")
  expect(duration("2026-10-20T10:00:00.000Z", "2026-10-20T10:00:04.250Z")).toBe("4.3s")
  expect(duration("2026-10-20T10:00:00.000Z", "2026-10-20T10:00:42.000Z")).toBe("42s")
  expect(duration("2026-10-20T10:00:00.000Z", "2026-10-20T10:03:05.000Z")).toBe("3m 5s")
  expect(duration("2026-10-20T10:00:00.000Z", "2026-10-20T12:10:00.000Z")).toBe("2h 10m")
  expect(duration("2026-10-20T10:00:00.000Z", null)).toBeNull()
  expect(duration(null, "2026-10-20T10:00:00.000Z")).toBeNull()
  expect(duration("2026-10-20T10:00:01.000Z", "2026-10-20T10:00:00.000Z")).toBeNull()
  expect(durationText(0)).toBe("0ms")
})

test("a node's work section by its kind: an agent's model calls, a case's route even when its kind isn't known", () => {
  expect(workOf({ kind: "agent", handle: null })).toBe("agent")
  expect(workOf({ kind: "case", handle: "reply" })).toBe("case")
  expect(workOf({ kind: null, handle: "#else" })).toBe("case")
  expect(workOf({ kind: "code", handle: null })).toBeNull()
  expect(workOf({ kind: null, handle: null })).toBeNull()
  // A kind with no section of its own, such as a loop's, has none; neither does a name like an Object member's.
  expect(workOf({ kind: "loop", handle: null })).toBeNull()
  expect(workOf({ kind: "constructor", handle: null })).toBeNull()
})

/** The options normalizer: the engine's label cleaning, then dropping the card's own action labels. */
import { expect, test } from "bun:test"
import { ToolSet } from "@ngocbh/yian/tools"
import { labels, normalizeOptions } from "../../src/questions/normalize.ts"

const CASES: [unknown, string[]][] = [
  [null, []],
  [["A", "B"], ["A", "B"]],
  ['["A","B"]', ["A", "B"]],
  ['["A", 2]', ["A"]],
  ["A, B", ["A, B"]],
  ["[broken", ["[broken"]],
  [["A", 3, null, { label: "x" }], ["A"]],
  [{ label: "x" }, []],
  [42, []],
  [[], []],
  [["  two\n  lines ", "", "   "], ["two lines"]],
  [["Yes", "yes", "YES", "No"], ["Yes", "No"]],
  [Array.from({ length: 9 }, (_, i) => String(i)), ["0", "1", "2", "3", "4", "5"]],
  [["x".repeat(100)], ["x".repeat(79) + "…"]],
]

// Wrapped: `test.each` spreads an array row, so a bare array value would become several arguments.
const VALUES = CASES.map(([value]) => [value] as const)

test.each(CASES)("labels are parsed squeezed cut deduplicated and at most six [%s]", (value, expected) => {
  expect(normalizeOptions(value)).toEqual(expected)
})

test.each(VALUES)("labels match composers cleaning [%s]", async (value) => {
  // yian doesn't export its cleaning, so the test reads it through `ToolSet`'s `ask_user` path; this catches the
  // two drifting apart.
  let seen: unknown = "unset"
  await new ToolSet({
    ask_user: (request) => {
      seen = request.options
      return ""
    },
  }).invoke("ask_user", { question: "q", options: value })
  expect(labels(value)).toEqual((seen ?? []) as string[])
})

test("action labels are dropped", () => {
  const got = normalizeOptions(["Type an answer", "chat about this", "SEND DISCUSSION BACK", "Stop", "Keep going"])
  expect(got).toEqual(["Keep going"])
})

test("stop the asker is dropped but other stops stay", () => {
  const got = normalizeOptions(["Stop minh", "Stop Minh Tran", "Stop the deploy"], { names: ["minh", "Minh Tran"] })
  expect(got).toEqual(["Stop the deploy"])
})

const ACTION_LOOKALIKES = [
  "Stop.",
  "Stop!",
  "Chat about this?",
  "Type an answer…",
  "Ｓｔｏｐ",
  "St\u200bop",
  "Send discussion-back",
  "\u201cStop\u201d",
  "Stop, minh",
  "stop\u00a0MINH",
  "Stop ✋",
  "Stop ✋\ufe0f",
  "🛑Stop",
  "⛔ Stop minh",
  "Stop → minh",
].map((label) => [label] as const)

test.each(ACTION_LOOKALIKES)(
  "action labels match through punctuation symbols width and invisible characters [%s]",
  (label) => {
    expect(normalizeOptions([label, "Keep going"], { names: ["minh"] })).toEqual(["Keep going"])
  },
)

const NOT_ACTIONS = ["Stopwatch", "Stop the deploy", "Stop minh's job", "Chat about that", "Stop ✋ the deploy"].map(
  (label) => [label] as const,
)

test.each(NOT_ACTIONS)("labels that only look like actions stay [%s]", (label) => {
  expect(normalizeOptions([label], { names: ["minh"] })).toEqual([label])
})

test("the six are kept before action labels are dropped", () => {
  // The engine has already cut a model ask_user's options to six; the office does the same.
  const got = normalizeOptions(["Chat about this", ...Array.from({ length: 6 }, (_, i) => `o${i}`)])
  expect(got).toEqual(["o0", "o1", "o2", "o3", "o4"])
})

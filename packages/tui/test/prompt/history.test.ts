import { describe, expect, test } from "bun:test"
import { isDuplicateEntry, MAX_HISTORY_ENTRIES, parsePromptHistory } from "../../src/prompt/history"

describe("prompt history", () => {
  test("recovers valid JSONL entries around corruption", () => {
    expect(parsePromptHistory(`${JSON.stringify("one")}\nnot-json\n${JSON.stringify("two")}\n`)).toEqual(["one", "two"])
  })

  test("reads the input of older object entries", () => {
    expect(parsePromptHistory(`${JSON.stringify({ input: "old", parts: [], mode: "shell" })}\n`)).toEqual(["old"])
  })

  test("retains only the newest entries", () => {
    const input = Array.from({ length: MAX_HISTORY_ENTRIES + 5 }, (_, index) => JSON.stringify(String(index))).join(
      "\n",
    )
    const result = parsePromptHistory(input)
    expect(result).toHaveLength(MAX_HISTORY_ENTRIES)
    expect(result[0]).toBe("5")
  })

  test("dedupes only identical consecutive entries", () => {
    expect(isDuplicateEntry(undefined, "hello")).toBe(false)
    expect(isDuplicateEntry("hello", "hello")).toBe(true)
    expect(isDuplicateEntry("foo", "bar")).toBe(false)
  })
})

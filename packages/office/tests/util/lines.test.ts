/** Text as a note to an agent quotes it: an output's last lines in a few bytes, a long text on one line, a fence no
 *  line of the text can close, and how long something ran. */
import { expect, test } from "bun:test"
import { elapsed, fence, lastLines, oneLine, tailBytes } from "../../src/util/lines.ts"

test("the last lines: at most so many, whole lines dropped from the front to fit the bytes, then a long line's end", () => {
  const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
  expect(lastLines(text, { lines: 3, bytes: 2048 })).toBe("line 28\nline 29\nline 30")
  expect(lastLines("aaaa\nbbbb\ncccc", { lines: 10, bytes: 9 })).toBe("bbbb\ncccc")
  expect(lastLines("x".repeat(10), { lines: 10, bytes: 4 })).toBe("xxxx")
  // A first line cut at its start goes when another follows it.
  expect(lastLines("tail of a line\nwhole", { lines: 10, bytes: 2048, cut: true })).toBe("whole")
  expect(lastLines("only", { lines: 10, bytes: 2048, cut: true })).toBe("only")
  expect(lastLines("", { lines: 10, bytes: 2048 })).toBe("")
})

test("a text's end in bytes never splits a character", () => {
  expect(tailBytes("aé€", 4)).toBe("€")
  expect(tailBytes("aé€", 5)).toBe("é€")
  expect(tailBytes("abc", 10)).toBe("abc")
})

test("one line: white space collapsed, and the first characters with an ellipsis", () => {
  expect(oneLine("make  all\n\tdocs ", 200)).toBe("make all docs")
  expect(oneLine("abcdef", 3)).toBe("abc…")
})

test("a fence is longer than any run of backticks in the text, and at least three", () => {
  expect(fence("plain")).toBe("```")
  expect(fence("a ```` b")).toBe("`````")
})

test("a duration as a note says it", () => {
  expect([elapsed(12.4), elapsed(252), elapsed(3780)]).toEqual(["12s", "4m12s", "1h03m"])
})

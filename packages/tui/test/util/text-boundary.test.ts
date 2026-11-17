// The newest part of a shell's output that a view keeps, cut where it cuts no character or escape sequence. `tail`'s
// cases are the upstream TUI's own.
import { expect, test } from "bun:test"
import { lineTail, tail } from "../../src/util/text-boundary"

const samples = ["", "ascii", "ab😀cd", "😀é€�😀"]

test.each(samples)("every tail of %j keeps whole characters within the limit", (text) => {
  for (let limit = 0; limit <= text.length + 1; limit++) {
    const part = tail(text, limit)
    expect(text.endsWith(part)).toBe(true)
    expect(part.isWellFormed()).toBe(true)
    expect(part.length).toBeLessThanOrEqual(limit)
    expect(part.length).toBeGreaterThanOrEqual(Math.min(limit, text.length) - 1)
  }
})

test("a tail keeps malformed input that is not at the cut", () => {
  expect(tail("\ude00a", 2)).toBe("\ude00a")
  expect(tail("b\ude00a", 2)).toBe("a")
})

test("a line tail starts at a line when one starts inside it, so an escape sequence isn't cut", () => {
  expect(lineTail("abc", 5)).toBe("abc")
  // The cut falls inside "\x1b[31m": the kept part starts at the next line.
  expect(lineTail("one \x1b[31mred\x1b[0m\ntwo\nthree", 16)).toBe("two\nthree")
  // With no line start inside it, it keeps whole characters.
  expect(lineTail("x😀yz", 3)).toBe("yz")
})

import { expect, test } from "bun:test"
import { display, printable } from "../../src/util/printable"

test("printable drops control characters but keeps tabs and newlines", () => {
  expect(printable("a\x00b\x07c\x0ed\x1be\x7ff\x9bg\rh\ti\nj")).toBe("abcdefgh\ti\nj")
  expect(printable("plain words")).toBe("plain words")
})

test("display removes terminal sequences whole, leaving no visible remains", () => {
  expect(display("\x1b[31mX\x1b[0m")).toBe("X")
  expect(display("a\x1b]0;T\x07b")).toBe("ab")
  expect(display("a\x9b31mb")).toBe("ab")
  expect(display("SO\x0eX bell\x07 end\tx\nnext")).toBe("SOX bell end\tx\nnext")
})

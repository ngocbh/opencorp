/** How a command or script that will run is shown to the owner, and what the model may send to run. */
import { expect, test } from "bun:test"
import { lineCount, numberedLines, oddCharacter, shownCode } from "../../src/reach/show.ts"

/** Look-alike blanks that aren't shell whitespace, and invisible ones. */
const LOOK_ALIKES = [" ", " ", "　", " ", "⠀", "ㅤ"]

test.each(LOOK_ALIKES)("a look-alike blank is shown escaped and named for the model [%p]", (blank) => {
  const hex = blank.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")
  const command = `echo listing jobs${blank}# ; touch PWNED`
  expect(shownCode(command)).toBe(`echo listing jobs<U+${hex}># ; touch PWNED`)
  expect(oddCharacter(`true\n${command}`)).toBe(`U+${hex} at line 2, column 18`)
})

test("printable ASCII, tabs and newlines pass; control characters, emoji and lone surrogates don't", () => {
  expect(oddCharacter("set -eu\n\tssh login1 true\n")).toBeNull()
  expect(shownCode("a\tb")).toBe("a\tb")
  expect(shownCode("a\x1b[2Jb\rc")).toBe("a<U+001B>[2Jb<U+000D>c")
  expect(shownCode("x\u{1F600}y")).toBe("x<U+1F600>y")
  expect(shownCode("x\ud83dy")).toBe("x<U+D83D>y")
  expect(oddCharacter("ok\u{1F600}")).toBe("U+1F600 at line 1, column 3")
})

test("lines are numbered, and a run of blank lines is one marker that keeps the numbering", () => {
  const padded = `touch x\n${"\n".repeat(60)}squeue\n`
  expect(lineCount(padded)).toBe(62)
  expect(numberedLines(padded)).toEqual(["   1  touch x", "      (60 blank lines)", "  62  squeue"])
  expect(numberedLines("a\n\nb")).toEqual(["  1  a", "  2", "  3  b"])
  expect(numberedLines("a\n \t\n\t\nb")).toEqual(["  1  a", "     (2 blank lines)", "  4  b"])
  expect(lineCount("one")).toBe(1)
  expect(lineCount("one\n")).toBe(1)
})

test("a line of escaped look-alikes isn't blank, so it can't hide in a marker", () => {
  expect(numberedLines("a\n \n \nb")).toEqual(["  1  a", "  2  <U+00A0>", "  3  <U+00A0>", "  4  b"])
  // Shown another way (notes, as text), look-alike blank lines are blank.
  expect(numberedLines("a\n　\n⠀\nb", (line) => line)).toEqual(["  1  a", "     (2 blank lines)", "  4  b"])
})

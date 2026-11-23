import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { deleteCells } from "../../src/prompt/content"

let setup: TestRendererSetup
let input: TextareaRenderable

beforeAll(async () => {
  setup = await createTestRenderer({ width: 80, height: 8 })
  input = new TextareaRenderable(setup.renderer, { width: 80, height: 6 })
  setup.renderer.root.add(input)
})

afterAll(() => setup.renderer.destroy())

/** The cell offsets the cursor stops at, from the start to the end. */
function stops(text: string) {
  input.setText(text)
  input.cursorOffset = 0
  const out = [0]
  while (input.moveCursorRight() && input.cursorOffset !== out.at(-1)) out.push(input.cursorOffset)
  return out
}

/** What the autocomplete did before deleteCells: move the cursor to each end for its position, then delete. */
function cursorWalk(start: number, end: number) {
  input.cursorOffset = start
  const from = input.logicalCursor
  input.cursorOffset = end
  const to = input.logicalCursor
  input.deleteRange(from.row, from.col, to.row, to.col)
}

/** The text and cursor that `remove` leaves after deleting [start, end) from `text` with the cursor at `end`, as the
 *  autocomplete deletes what was typed up to the cursor. */
function after(text: string, start: number, end: number, remove: (start: number, end: number) => void) {
  input.setText(text)
  input.cursorOffset = end
  remove(start, end)
  return { text: input.plainText, cursor: input.cursorOffset }
}

const CASES: [string, string][] = [
  ["CJK", "中文 @src 한국어 こんにちは"],
  ["emoji with skin tones", "hi 👍🏽 @there 👋🏿!"],
  ["ZWJ families", "👨‍👩‍👧‍👦 @src 👩‍❤️‍👨 end"],
  ["zero-width characters", "a​b @c‍d⁠e"],
  ["combining marks", "é café @x"],
  ["multi-line text", "@file1\n中文 @two\n👍🏽 end\n"],
]

describe("deleteCells", () => {
  test.each(CASES)("deletes as the cursor walk did, between every two cursor stops [%s]", (_case, text) => {
    const at = stops(text)
    expect(at.length).toBeGreaterThan(3)
    for (const [i, start] of at.entries())
      for (const end of at.slice(i))
        expect({ start, end, ...after(text, start, end, (a, b) => deleteCells(input, a, b)) }).toEqual({
          start,
          end,
          ...after(text, start, end, cursorWalk),
        })
  })

  test("deletes a mention's typed text after wide characters, on its line, and leaves the cursor at its start", () => {
    const text = "👨‍👩‍👧‍👦 中文\n🙂 @sr tail"
    const start = Bun.stringWidth("👨‍👩‍👧‍👦 中文") + 1 + Bun.stringWidth("🙂 ")
    expect(after(text, start, start + 3, (a, b) => deleteCells(input, a, b))).toEqual({
      text: "👨‍👩‍👧‍👦 中文\n🙂  tail",
      cursor: start,
    })
  })

  test("an empty range deletes nothing", () => {
    expect(after("中文 @src", 3, 3, (a, b) => deleteCells(input, a, b))).toEqual({ text: "中文 @src", cursor: 3 })
  })
})

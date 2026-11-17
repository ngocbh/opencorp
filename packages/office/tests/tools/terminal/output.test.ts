/** The model's view of a shell: the screen's text, as it is, read in pages. */
import { expect, test } from "bun:test"
import { ModelView, PlainText, VIEW_KEEP } from "../../../src/tools/terminal/output.ts"

/** The whole of `view`'s text. */
const textOf = (view: ModelView): string => view.page(0, view.length + 1).output

/** A view fed `chunks`, in order. */
function viewOf(...chunks: string[]): ModelView {
  const view = new ModelView()
  for (const chunk of chunks) view.append(chunk)
  return view
}

test("escape sequences and the shell's markers never reach the model's view", () => {
  const pairs: [string, string][] = [
    // Colors, cursor moves and erases (the cases of OpenCode's `ansi.test.ts`, df46f69).
    ["\x1b[31mred\x1b[0m \x1b[1;32;40mbold\x1b[m", "red bold"],
    ["a\x1b[2K\x1b[1Gb\x1b[10;20Hc", "abc"],
    ["\x1b[38:2:255:0:0mtruecolor\x1b[0m", "truecolor"],
    ["\x9b31mc1\x9b0m", "c1"],
    // OSC, with each terminator: a title, a hyperlink, and the shell's own marker.
    ["\x1b]0;title\x07text", "text"],
    ["\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\", "link"],
    ["\x1b]0;title\x9ctext", "text"],
    ["before\x1b]633;opencorp-mark;7f3a9c;0\x07after", "beforeafter"],
    // Single-character escapes, a charset, modes, a DCS string, a bell.
    ["\x1b7saved\x1b8\x1b=\x1b>\x1b(B\x1bM", "saved"],
    ["\x1b[?2004h\x1b[?1049hfull\x1b[?1049l\x1b[?2004l", "full"],
    ["\x1bPq#0;2;0;0;0\x1b\\after\x07", "after"],
    // Plain text, tabs and brackets stay.
    ["[31mnot an escape\tok", "[31mnot an escape\tok"],
  ]
  for (const [raw, plain] of pairs) {
    expect(textOf(viewOf(`${raw}\r\n`)), JSON.stringify(raw)).toBe(`${plain}\n`)
    // Split anywhere, even inside an escape, the view is the same.
    expect(textOf(viewOf(...`${raw}\r\n`)), JSON.stringify(raw)).toBe(`${plain}\n`)
  }

  const plain = new PlainText()
  expect(plain.push("ok\x1b[3")).toBe("ok")
  expect(plain.push("1mred\x1b]633;opencorp-")).toBe("red")
  expect(plain.push("mark;1;0\x07\r")).toBe("")
  expect(plain.push("\n")).toBe("\n")
  expect(plain.push("\x1b[")).toBe("")
  expect(plain.flush()).toBe("")
  expect(plain.push("x")).toBe("x")
})

test("a line redrawn with CR keeps its last text, and backspaces apply", () => {
  expect(textOf(viewOf("progress 10%\rprogress 55%\rprogress 100%\r\n"))).toBe("progress 100%\n")
  expect(textOf(viewOf("Receiving objects:  45%\r\x1b[KReceiving objects: 100%, done.\r\n"))).toBe(
    "Receiving objects: 100%, done.\n",
  )
  // A CR-LF split across chunks is one line end, and so is CR CR LF.
  expect(textOf(viewOf("one\r", "\ntwo\r\r\n"))).toBe("one\ntwo\n")
  // The tty's echo of an erased character, and backspaces that never cross a line.
  expect(textOf(viewOf("pas\b \bss\r\n"))).toBe("pass\n")
  expect(textOf(viewOf("\b\bok\r\na\r\n\bb\r\n"))).toBe("ok\na\nb\n")

  // A line keeps its text until something is written over it.
  const view = viewOf("50%\r")
  expect(textOf(view)).toBe("50%")
  view.append("75%\r")
  expect(textOf(view)).toBe("75%")
  view.append("\n")
  expect(textOf(view)).toBe("75%\n")
})

test("a long output comes in pages with where the next starts, never cut", () => {
  const lines = Array.from({ length: 500 }, (_, n) => `line ${n} ${"x".repeat(n % 37)}\n`).join("")
  const view = new ModelView()
  for (let at = 0; at < lines.length; at += 997) view.append(lines.slice(at, at + 997).replaceAll("\n", "\r\n"))
  expect(view.length).toBe(lines.length)

  let from = 0
  let read = ""
  for (;;) {
    const page = view.page(from, 1000)
    expect(page.next).toBe(from + page.output.length)
    read += page.output
    from = page.next
    if (!page.more) break
    expect(page.output.length).toBe(1000)
  }
  expect(read).toBe(lines)
  expect(from).toBe(view.length)
  expect(view.page(view.length, 1000)).toEqual({ output: "", next: view.length, more: false })

  // A character is never cut in half.
  const wide = viewOf("ab\u{1F600}cd\n")
  expect(wide.page(0, 3)).toEqual({ output: "ab", next: 2, more: true })
  expect(wide.page(2, 3)).toEqual({ output: "\u{1F600}c", next: 5, more: true })

  // The unfinished last line, which a redraw can still change, comes whole in every page that reaches it.
  const prompt = viewOf("Get:1 http://archive\r\n", "Continue? [y/N] ")
  const first = prompt.page(0, 1000)
  expect(first).toEqual({ output: "Get:1 http://archive\nContinue? [y/N] ", next: 21, more: false })
  prompt.append("y\r\nInstalling\r\n")
  expect(prompt.page(first.next, 1000)).toEqual({ output: "Continue? [y/N] y\nInstalling\n", next: 50, more: false })

  const bar = viewOf("10%")
  const seen = bar.page(0, 1000)
  expect(seen).toEqual({ output: "10%", next: 0, more: false })
  bar.append("\r100%\r\ndone\r\n")
  expect(bar.page(seen.next, 1000)).toEqual({ output: "100%\ndone\n", next: 10, more: false })
})

test("past its cap the view keeps only the last output, at the same offsets, and says what is gone", () => {
  const lines = Array.from({ length: 100_000 }, (_, n) => `${String(n).padStart(6, "0")} ${"y".repeat(57)}\n`).join("")
  expect(lines.length).toBeGreaterThan(VIEW_KEEP * 1.5)
  const view = new ModelView()
  for (let at = 0; at < lines.length; at += 65_536) view.append(lines.slice(at, at + 65_536))
  expect(view.length).toBe(lines.length)

  const first = view.page(0, 1000)
  const start = first.next - first.output.length
  expect(start).toBeGreaterThan(0)
  expect(lines.length - start).toBeGreaterThanOrEqual(VIEW_KEEP)
  expect(lines.length - start).toBeLessThanOrEqual(VIEW_KEEP * 1.25)
  expect(first.skipped).toBe(`Output before offset ${start} is no longer in memory; the shell's record keeps all of it.`)
  expect(first.output).toBe(lines.slice(start, start + 1000))
  expect(first.more).toBe(true)

  // Offsets stay absolute: reading on from there gives the rest, with nothing more said.
  const rest = view.page(first.next, lines.length)
  expect(rest).toEqual({ output: lines.slice(first.next), next: lines.length, more: false })

  // A single line longer than the cap keeps its tail, and a redraw still starts it over.
  const long = viewOf("z".repeat(VIEW_KEEP * 2))
  const tail = long.page(0, VIEW_KEEP * 2)
  expect(tail.skipped).toBeDefined()
  expect(tail.output).toBe("z".repeat(VIEW_KEEP))
  long.append("\rdone\r\n")
  expect(long.page(tail.next, 100)).toEqual({ output: "done\n", next: VIEW_KEEP + 5, more: false })
})

test("typed input the terminal echoed stays in the view, as on screen", () => {
  const view = viewOf(
    "$ read x; echo $x\r\n",
    // The tty's echo of the owner's typed line, then the program printing it back.
    "owner-typed-text\r\n",
    "\x1b[1mowner-typed-text\x1b[0m\r\n",
    // A secret prompt shows; what was typed at it with echo off never reached the output.
    "$ sudo true\r\n[sudo] password for nhb25: ",
    "\r\n",
    "$ ",
  )
  expect(textOf(view)).toBe(
    "$ read x; echo $x\nowner-typed-text\nowner-typed-text\n$ sudo true\n[sudo] password for nhb25: \n$ ",
  )
})

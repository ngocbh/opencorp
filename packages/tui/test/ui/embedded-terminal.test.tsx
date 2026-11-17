/** @jsxImportSource @opentui/solid */
// OpenTUI's embedded terminal, as a shell's view draws it: fed a program's bytes, sized, themed with OSC 4, given
// keys while focused, and scrolled with the wheel.
import { EmbeddedTerminalRenderable, RGBA } from "@opentui/core"
import { extend, testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    embeddedTerminal: typeof EmbeddedTerminalRenderable
  }
}

extend({ embeddedTerminal: EmbeddedTerminalRenderable })

/** Mounts one terminal at the top left of a 40x12 screen, `cols` by `rows`; returns it, the frame helpers, the
 *  input bytes it sent, and a setter for its size. */
async function mount(cols = 20, rows = 5) {
  const [size, setSize] = createSignal({ cols, rows })
  const sent: string[] = []
  let terminal!: EmbeddedTerminalRenderable
  const app = await testRender(
    () => (
      <embeddedTerminal
        ref={(value) => (terminal = value)}
        position="absolute"
        left={0}
        top={0}
        width={size().cols}
        height={size().rows}
        onData={(data, source) => {
          if (source === "input") sent.push(new TextDecoder().decode(data))
        }}
      />
    ),
    { width: 40, height: 12 },
  )
  await app.renderOnce()
  return { app, terminal, sent, setSize }
}

test("OpenTUI's embedded terminal draws a program's bytes as a terminal would", async () => {
  const { app, terminal } = await mount()
  terminal.write("\x1b]4;1;#c81e1e\x1b\\")
  terminal.write("\x1b[31mred\x1b[0m\r\nab\x1b[Dc")
  await app.renderOnce()
  expect(terminal.screen().lines).toEqual(["red", "ac"])
  const rows = app.captureCharFrame().split("\n")
  expect(rows[0]!.trimEnd()).toBe("red")
  expect(rows[1]!.trimEnd()).toBe("ac")
  const red = app.captureSpans().lines[0]!.spans.find((span) => span.text.startsWith("red"))
  expect(red?.fg.toInts().slice(0, 3)).toEqual(RGBA.fromHex("#c81e1e").toInts().slice(0, 3))
  app.renderer.destroy()
})

test("it takes a size, and keeps the text that fits after a resize", async () => {
  const { app, terminal, setSize } = await mount(20, 5)
  const resized: [number, number][] = []
  terminal.onTerminalResize = (cols, rows) => resized.push([cols, rows])
  expect(terminal.screen()).toMatchObject({ columns: 20, rows: 5 })
  terminal.write("one\r\ntwo\r\nthree")
  await app.renderOnce()
  setSize({ cols: 12, rows: 3 })
  await app.renderOnce()
  expect(resized.at(-1)).toEqual([12, 3])
  const screen = terminal.screen()
  expect(screen).toMatchObject({ columns: 12, rows: 3 })
  expect(screen.lines).toEqual(["one", "two", "three"])
  expect(app.captureCharFrame().split("\n")[3]!.trim()).toBe("")
  app.renderer.destroy()
})

test("it encodes keys for the program: Enter, Backspace, Ctrl-C as \\x03, and the arrows as \\x1b[A normally and \\x1bOA after the program sends \\x1b[?1h", async () => {
  const { app, terminal, sent } = await mount()
  terminal.focus()
  sent.length = 0
  app.mockInput.pressEnter()
  app.mockInput.pressBackspace()
  app.mockInput.pressKey("c", { ctrl: true })
  app.mockInput.pressArrow("up")
  terminal.write("\x1b[?1h")
  app.mockInput.pressArrow("up")
  await app.renderOnce()
  expect(sent).toEqual(["\r", "\x7f", "\x03", "\x1b[A", "\x1bOA"])
  app.renderer.destroy()
})

test("it scrolls, keeping its scrollback", async () => {
  const { app, terminal } = await mount(20, 5)
  terminal.write(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\r\n"))
  await app.renderOnce()
  expect(terminal.screen().lines).toEqual(["line 26", "line 27", "line 28", "line 29", "line 30"])
  expect(terminal.getScroll().total).toBeGreaterThanOrEqual(30)
  await app.mockMouse.scroll(2, 2, "up")
  await app.renderOnce()
  expect(terminal.getScroll().offset).toBeGreaterThan(0)
  expect(terminal.screen().lines).toEqual(["line 23", "line 24", "line 25", "line 26", "line 27"])
  await app.mockMouse.scroll(2, 2, "down")
  await app.renderOnce()
  expect(terminal.screen().lines.at(-1)).toBe("line 30")
  app.renderer.destroy()
})

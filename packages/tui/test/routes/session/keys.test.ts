// A focused shell's keys: every key but the leader goes to the shell, encoded by OpenTUI's embedded terminal; the
// leader and the key after it stay with the TUI's keymap, and the leader twice is the leader key itself. Keys go out
// gathered, as typed.
import { EmbeddedTerminalRenderable, type KeyEvent } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { expect, test } from "bun:test"
import { leaderKey, registerOpenCorpKeymap } from "../../../src/keymap"
import { keyBatch, lineEffect, routeShellKeys } from "../../../src/routes/session/keys"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

/** A keymap as the app registers it, with the TUI's own bindings on Esc, Ctrl-C, ctrl+o and `<leader>f`; a terminal
 *  whose keys route through `routeShellKeys`, and what it sent and which binding ran. */
async function mount() {
  const setup = await createTestRenderer({ width: 40, height: 10 })
  await setup.renderer.setupTerminal()
  const config = createTuiResolvedConfig({ leader_timeout: 2000 })
  const keymap = createDefaultOpenTuiKeymap(setup.renderer)
  const offKeymap = registerOpenCorpKeymap(keymap, setup.renderer, config)
  const ran: string[] = []
  const offLayer = keymap.registerLayer({
    bindings: [
      { key: "escape", cmd: () => void ran.push("close") },
      { key: "ctrl+c", cmd: () => void ran.push("exit") },
      { key: "ctrl+o", cmd: () => void ran.push("ctrl+o") },
      { key: "<leader>f", cmd: () => void ran.push("full") },
    ],
  })
  const sent: string[] = []
  const terminal = new EmbeddedTerminalRenderable(setup.renderer, {
    cols: 20,
    rows: 5,
    onData: (data, source) => {
      if (source === "input") sent.push(new TextDecoder().decode(data))
    },
  })
  setup.renderer.root.add(terminal)
  const offShell = routeShellKeys(keymap, leaderKey(config), {
    focused: () => terminal.focused,
    press: (event) => terminal.handleKeyPress(event),
  })
  terminal.focus()
  await setup.renderOnce()
  sent.length = 0
  return {
    setup,
    terminal,
    sent,
    ran,
    stop() {
      offShell()
      // Before the leader goes: a layer still registered then is compiled again without it, which warns.
      offLayer()
      offKeymap()
      setup.renderer.destroy()
    },
  }
}

/** Presses Esc alone: the key after it waits until the parser has taken it as Esc, not as Alt with that key. */
async function escape(keys: { pressEscape(): void }) {
  keys.pressEscape()
  await Bun.sleep(100)
}

test("inside a focused shell every key but the leader goes to the shell: Esc, Ctrl-C and ctrl+o included", async () => {
  const { setup, terminal, sent, ran, stop } = await mount()
  try {
    const keys = setup.mockInput
    await keys.typeText("ls")
    keys.pressEnter()
    await escape(keys)
    keys.pressKey("c", { ctrl: true })
    keys.pressKey("o", { ctrl: true })
    keys.pressTab()
    // Backspace as a terminal sends it.
    keys.pressKey("\x7f")
    keys.pressArrow("up")
    // Once the program asks for application cursor keys, the arrows follow.
    terminal.write("\x1b[?1h")
    keys.pressArrow("up")
    await Bun.sleep(50)
    await setup.renderOnce()
    expect(sent).toEqual(["l", "s", "\r", "\x1b", "\x03", "\x0f", "\t", "\x7f", "\x1b[A", "\x1bOA"])
    expect(ran).toEqual([])

    // Without the keys, the shell gets none and the TUI's bindings run.
    terminal.blur()
    sent.length = 0
    await escape(keys)
    keys.pressKey("c", { ctrl: true })
    keys.pressKey("o", { ctrl: true })
    await Bun.sleep(50)
    expect(sent).toEqual([])
    expect(ran).toEqual(["close", "exit", "ctrl+o"])
  } finally {
    stop()
  }
})

test("the leader and its next key stay with the TUI, and the leader twice sends the leader key to the shell", async () => {
  const { setup, sent, ran, stop } = await mount()
  try {
    const keys = setup.mockInput
    keys.pressKey("x", { ctrl: true })
    keys.pressKey("f")
    expect(ran).toEqual(["full"])
    expect(sent).toEqual([])
    // A key after the leader that runs nothing goes nowhere.
    keys.pressKey("x", { ctrl: true })
    keys.pressKey("z")
    expect(sent).toEqual([])
    // The leader twice is ^X, as nano reads it; the key after it is the shell's again.
    keys.pressKey("x", { ctrl: true })
    keys.pressKey("x", { ctrl: true })
    keys.pressKey("f")
    await Bun.sleep(50)
    expect(sent).toEqual(["\x18", "f"])
    expect(ran).toEqual(["full"])
  } finally {
    stop()
  }
})

test("keys go out gathered once a frame, in the order typed, a batch longer than a request in pieces", async () => {
  const out: string[] = []
  const batch = keyBatch((data) => out.push(data), 10)
  const bytes = (text: string) => new TextEncoder().encode(text)
  batch.push(bytes("hun"))
  batch.push(bytes("ter2"))
  batch.push(bytes("\r"))
  expect(out).toEqual([])
  await Bun.sleep(40)
  expect(out).toEqual(["hunter2\r"])

  // A paste longer than the office takes at once goes in order, never splitting a character.
  out.length = 0
  const long = "a".repeat(4095) + "😀" + "b".repeat(10)
  batch.push(bytes(long))
  batch.flush()
  expect(out.map((piece) => piece.length)).toEqual([4095, 12])
  expect(out.join("")).toBe(long)
  // Nothing is kept once sent.
  batch.flush()
  expect(out).toHaveLength(2)
})

test("a key types into the owner's line, ends it, or neither", async () => {
  const setup = await createTestRenderer({ width: 40, height: 10 })
  await setup.renderer.setupTerminal()
  const seen: string[] = []
  const listener = (event: KeyEvent) => void seen.push(String(lineEffect(event)))
  setup.renderer.keyInput.on("keypress", listener)
  try {
    const keys = setup.mockInput
    await keys.typeText("a-2 Zé")
    keys.pressKey("\x7f")
    keys.pressArrow("up")
    keys.pressKey("\x1b[5~")
    keys.pressTab({ shift: true })
    keys.pressEnter()
    keys.pressKey("c", { ctrl: true })
    keys.pressKey("d", { ctrl: true })
    keys.pressKey("u", { ctrl: true })
    await Bun.sleep(50)
    expect(seen).toEqual([
      ...Array(6).fill("types"),
      ...Array(4).fill("undefined"),
      "ends",
      "ends",
      "ends",
      "types",
    ])
  } finally {
    setup.renderer.keyInput.off("keypress", listener)
    setup.renderer.destroy()
  }
})

test("under the kitty keyboard protocol the numpad types, and a key the TUI doesn't know types too", () => {
  const key = (name: string, mods: Partial<KeyEvent> = {}) =>
    lineEffect({ name, ctrl: false, meta: false, shift: false, super: false, ...mods } as KeyEvent)
  for (const name of ["kp1", "kp0", "kpdecimal", "kpminus", "kpplus"]) expect(key(name)).toBe("types")
  // A name the list of keys that type nothing doesn't hold errs toward a line under way.
  expect(key("mediaplay")).toBe("types")
  // The keys that type nothing.
  for (const name of ["pageup", "pagedown", "up", "home", "end", "insert", "delete", "f5", "f12", "tab", "backspace"])
    expect(key(name)).toBeUndefined()
  for (const name of ["shift", "leftshift", "rightctrl", "alt", "capslock"]) expect(key(name)).toBeUndefined()
  expect(key("tab", { shift: true })).toBeUndefined()
  expect(key("kpenter")).toBe("ends")
})

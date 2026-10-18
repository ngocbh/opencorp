import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { createSignal, onCleanup, type JSX } from "solid-js"
import { resolve, TuiConfigProvider } from "../../src/config"
import { OpenCorpKeymapProvider, registerOpenCorpBaseKeymap } from "../../src/keymap"
import { SecretInput } from "../../src/setup/secret"

const SECRET = "sk-ant-sentinel-a7d93c10e5b2"

/** The keymap and config the setup screen gives its boxes. */
function Keys(props: { children: JSX.Element }) {
  const keymap = createDefaultOpenTuiKeymap(useRenderer())
  onCleanup(registerOpenCorpBaseKeymap(keymap))
  return (
    <OpenCorpKeymapProvider keymap={keymap}>
      <TuiConfigProvider config={resolve({}, { terminalSuspend: false })}>{props.children}</TuiConfigProvider>
    </OpenCorpKeymapProvider>
  )
}

test("a secret shows as dots, never as typed, and Enter hands over the full text", async () => {
  const got: string[] = []
  const app = await testRender(
    () => (
      <Keys>
        <SecretInput placeholder="Paste or type it here; it isn't shown" onSubmit={(v) => got.push(v)} />
      </Keys>
    ),
    { width: 80, height: 5, exitOnCtrlC: false },
  )
  const dots = (n: number) => "•".repeat(n)
  const frame = async () => {
    await app.renderOnce()
    const f = app.captureCharFrame()
    expect(f).not.toContain("sentinel")
    return f
  }
  try {
    expect(await frame()).toContain("Paste or type it here; it isn't shown")
    await app.mockInput.typeText(SECRET)
    // Tab and Ctrl-J are control characters, not part of a key.
    app.mockInput.pressTab()
    app.mockInput.pressKey("\n")
    expect(await frame()).toContain(dots(28))
    expect(await frame()).not.toContain(dots(29))
    expect(await frame()).not.toContain("Paste or type it here")
    app.mockInput.pressBackspace()
    expect(await frame()).not.toContain(dots(28))
    expect(await frame()).toContain(dots(27))
    await app.mockInput.pasteBracketedText("a\tb\r\nc\x1b")
    expect(await frame()).toContain(dots(30))
    expect(await frame()).not.toContain(dots(31))
    app.mockInput.pressEnter()
    expect(got).toEqual([SECRET.slice(0, -1) + "abc"])
    expect(await frame()).toContain("Paste or type it here; it isn't shown")
  } finally {
    app.renderer.destroy()
  }
})

test("Ctrl+C or Esc empties the box: the dots go, and Enter then hands over only what came after", async () => {
  const got: string[] = []
  const app = await testRender(
    () => (
      <Keys>
        <SecretInput placeholder="Paste or type it here; it isn't shown" onSubmit={(v) => got.push(v)} />
      </Keys>
    ),
    { width: 80, height: 5, exitOnCtrlC: false },
  )
  const frame = async () => {
    await app.renderOnce()
    const f = app.captureCharFrame()
    expect(f).not.toContain("sentinel")
    return f
  }
  try {
    await app.mockInput.typeText(SECRET)
    expect(await frame()).toContain("•".repeat(28))
    app.mockInput.pressCtrlC()
    expect(await frame()).toContain("Paste or type it here; it isn't shown")
    await app.mockInput.typeText("ab")
    app.mockInput.pressEscape()
    // A lone ESC counts as Esc only after the input parser's timeout, so wait for the box to empty.
    for (let i = 0; i < 50 && !(await frame()).includes("Paste or type it here"); i++) await Bun.sleep(10)
    expect(await frame()).toContain("Paste or type it here; it isn't shown")
    await app.mockInput.typeText("xyz")
    app.mockInput.pressEnter()
    expect(got).toEqual(["xyz"])
  } finally {
    app.renderer.destroy()
  }
})

test("a disabled box takes no keys and no paste, and enabling it takes them again", async () => {
  const got: string[] = []
  const changes: string[] = []
  const [enabled, setEnabled] = createSignal(false)
  const app = await testRender(
    () => (
      <Keys>
        <SecretInput
          placeholder="Paste or type it here; it isn't shown"
          enabled={enabled()}
          onChange={(v) => changes.push(v)}
          onSubmit={(v) => got.push(v)}
        />
      </Keys>
    ),
    { width: 80, height: 5, exitOnCtrlC: false },
  )
  try {
    await app.mockInput.typeText("steer")
    await app.mockInput.pasteBracketedText("pasted")
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Paste or type it here; it isn't shown")
    expect([got, changes]).toEqual([[], []])
    setEnabled(true)
    await app.mockInput.typeText("ab")
    app.mockInput.pressEnter()
    expect(got).toEqual(["ab"])
    expect(changes).toEqual(["a", "ab", ""])
  } finally {
    app.renderer.destroy()
  }
})

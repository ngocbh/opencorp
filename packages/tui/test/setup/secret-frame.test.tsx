import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { SecretInput } from "../../src/setup/secret"

const SECRET = "sk-ant-sentinel-a7d93c10e5b2"

test("a secret shows as dots, never as typed, and Enter hands over the full text", async () => {
  const got: string[] = []
  const app = await testRender(
    () => <SecretInput placeholder="Paste or type it here; it isn't shown" onSubmit={(v) => got.push(v)} />,
    { width: 80, height: 5 },
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

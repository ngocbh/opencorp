import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { SecretInput } from "../../src/setup/secret"

const SECRET = "sk-ant-sentinel-a7d93c10e5b2"

test("a secret shows as dots, never as typed, and Enter hands over the full text", async () => {
  const got: string[] = []
  const app = await testRender(() => <SecretInput question="API key" onSubmit={(v) => got.push(v)} />, {
    width: 80,
    height: 5,
  })
  const dots = (n: number) => "API key: " + "•".repeat(n)
  const frame = async () => {
    await app.renderOnce()
    const f = app.captureCharFrame()
    expect(f).not.toContain("sentinel")
    return f
  }
  try {
    await app.mockInput.typeText(SECRET)
    expect(await frame()).toContain(dots(28))
    expect(await frame()).not.toContain(dots(29))
    app.mockInput.pressBackspace()
    expect(await frame()).not.toContain(dots(28))
    expect(await frame()).toContain(dots(27))
    await app.mockInput.pasteBracketedText("ab\nc")
    expect(await frame()).toContain(dots(30))
    expect(await frame()).not.toContain(dots(31))
    app.mockInput.pressEnter()
    expect(got).toEqual([SECRET.slice(0, -1) + "abc"])
    expect(await frame()).not.toContain("•")
  } finally {
    app.renderer.destroy()
  }
})

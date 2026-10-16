import { expect, test } from "bun:test"
import { createFakeOffice, createStub, seed } from "../../../script/stub"
import { bootFrame } from "../../fixture/frame"
import { typeInto } from "./type"

/** The fake office, with minh using Codex as well as composer. */
function codexOffice() {
  const s = seed()
  s.people = s.people.map((p) => (p.handle === "minh" ? { ...p, harnesses: ["composer", "codex"] } : p))
  return createFakeOffice({ seed: s })
}

/** Opens the picker and picks minh's Codex row; the prompt's footer then names Codex. Returns the picker's frame. */
async function pickCodex(app: Awaited<ReturnType<typeof bootFrame>>) {
  await app.until((f) => f.includes("@minh"))
  app.input.pressKey("x", { ctrl: true })
  await app.setup.renderOnce()
  app.input.pressKey("p")
  const f = await app.until((f) => f.includes("@minh · Codex"))
  await typeInto(app, "Codex")
  app.input.pressEnter()
  await app.until((f) => !f.includes("Who do you want") && f.includes("@minh · Software engineer · Codex"))
  return f
}

test("a person who uses Codex has a Codex row, and picking it picks the harness", async () => {
  const fake = codexOffice()
  const app = await bootFrame(createStub(fake))
  try {
    const picker = await pickCodex(app)
    // One row per harness; the current one (composer, minh's first) is marked, as rows are compared by value.
    expect(picker).toContain("● @minh Minh · Software engineer")
    expect(picker).toContain("@minh · Codex Minh · Software engineer")
  } finally {
    await app.stop()
    fake.stop()
  }
})

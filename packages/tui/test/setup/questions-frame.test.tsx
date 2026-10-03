import { expect, test } from "bun:test"
import { SPINNER_FRAMES } from "../../src/component/spinner"
import { until } from "../fixture/until"
import { bootSetup, FakeChild } from "./boot"

const SECRET = "sk-ant-sentinel-a7d93c10e5b2"
const spinning = (f: string) => SPINNER_FRAMES.some((c) => f.includes(c))

/** Boots the screen for a fresh child once it shows the spinner. */
async function boot() {
  const child = new FakeChild()
  const app = await bootSetup(child)
  await app.until((f) => f.includes("Working…"))
  return { child, app }
}

test("an ask starts at its default; a typed answer is sent and shown", async () => {
  const { child, app } = await boot()
  try {
    child.push({ type: "ask", question: "Company", default: "Acme Inc" })
    await app.until((f) => f.includes("Company: Acme Inc") && !f.includes("Working…"))
    for (let i = 0; i < "Acme Inc".length; i++) app.input.pressBackspace()
    await app.input.typeText("Acme")
    app.input.pressEnter()
    await until(() => child.answers.length === 1)
    expect(child.answers).toEqual(["Acme"])
    const f = await app.until((f) => f.includes("Working…"))
    expect(f).toContain("Company: Acme")
    expect(f).not.toContain("Acme Inc")

    child.push({ type: "ask", question: "Your name", default: "Ngoc" })
    await app.until((f) => f.includes("Your name: Ngoc") && !f.includes("Working…"))
    app.input.pressEnter()
    await until(() => child.answers.length === 2)
    expect(child.answers[1]).toBe("Ngoc")
    child.end(0)
    await app.task
    expect(app.out()).toBe("Company: Acme\nYour name: Ngoc\n")
  } finally {
    await app.stop()
  }
})

test("a URL answer is sent whole but shown without its user and password", async () => {
  const { child, app } = await boot()
  const url = "https://x-access-token:ghp_sentinel42@github.com/a/b.git"
  try {
    child.push({ type: "ask", question: "Company repo", default: "" })
    await app.until((f) => f.includes("Company repo:") && !f.includes("Working…"))
    await app.input.typeText(url)
    app.input.pressEnter()
    await until(() => child.answers.length === 1)
    expect(child.answers).toEqual([url])
    const f = await app.until((f) => f.includes("Working…"))
    expect(f).toContain("Company repo: https://***@github.com/a/b.git")
    expect(f).not.toContain("ghp_sentinel42")
    child.end(0)
    await app.task
    expect(app.out()).toBe("Company repo: https://***@github.com/a/b.git\n")
  } finally {
    await app.stop()
  }
})

test("a choice starts on its default; Down and Enter pick the next one", async () => {
  const { child, app } = await boot()
  try {
    const options = ["azure", "anthropic", "openai"]
    child.push({ type: "choose", question: "Model provider", options, default: "anthropic" })
    await app.until((f) => f.includes("Model provider") && f.includes("> anthropic") && f.includes("  azure"))
    app.input.pressArrow("down")
    await app.until((f) => f.includes("> openai"))
    app.input.pressEnter()
    await until(() => child.answers.length === 1)
    expect(child.answers).toEqual(["openai"])
    const f = await app.until((f) => f.includes("Working…"))
    expect(f).toContain("Model provider: openai")
    expect(f).not.toContain("azure")
    child.end(0)
    await app.task
    expect(app.out()).toBe("Model provider: openai\n")
  } finally {
    await app.stop()
  }
})

test("a long choice scrolls to keep the cursor in view", async () => {
  const { child, app } = await boot()
  const options = Array.from({ length: 40 }, (_, i) => `opt-${String(i + 1).padStart(2, "0")}`)
  try {
    child.push({ type: "say", text: "Pick one." })
    child.push({ type: "choose", question: "Deployment", options })
    await app.until((f) => f.includes("> opt-01"))
    for (let i = 0; i < 39; i++) app.input.pressArrow("down")
    const f = await app.until((f) => f.includes("> opt-40"))
    expect(f).not.toContain("opt-01")
    expect(f).toContain("Pick one.")
    app.input.pressEnter()
    await until(() => child.answers.length === 1)
    expect(child.answers).toEqual(["opt-40"])
  } finally {
    await app.stop()
  }
})

test("a secret shows only as dots and is never shown or printed", async () => {
  const { child, app } = await boot()
  try {
    child.push({ type: "secret", question: "API key" })
    await app.until((f) => f.includes("API key:") && !f.includes("Working…"))
    await app.input.typeText(SECRET)
    const typed = await app.until((f) => f.includes("API key: " + "•".repeat(28)))
    expect(typed).not.toContain("sentinel")
    app.input.pressEnter()
    await until(() => child.answers.length === 1)
    expect(child.answers).toEqual([SECRET])
    const f = await app.until((f) => f.includes("Working…"))
    expect(f).toContain("API key: (hidden)")
    expect(f).not.toContain("sentinel")
    expect(f).not.toContain("•")
    child.end(0)
    await app.task
    expect(app.out()).toBe("API key: (hidden)\n")
    expect(app.frames.filter((f) => f.includes("sentinel"))).toEqual([])
  } finally {
    await app.stop()
  }
})

test("after an answer the spinner shows until the next prompt", async () => {
  const { child, app } = await boot()
  try {
    child.push({ type: "ask", question: "Company", default: "Acme" })
    await app.until((f) => f.includes("Company: Acme") && !f.includes("Working…"))
    app.input.pressEnter()
    let f = await app.until((f) => f.includes("Working…"))
    expect(spinning(f)).toBe(true)
    child.push({ type: "ask", question: "Your name", default: "" })
    f = await app.until((f) => f.includes("Your name:"))
    expect(f).not.toContain("Working…")
  } finally {
    await app.stop()
  }
})

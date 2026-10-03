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

test("an ask names its default in the gray placeholder; typed text replaces it, Enter alone takes it", async () => {
  const { child, app } = await boot()
  try {
    child.push({ type: "ask", question: "Company", default: "Acme Inc" })
    let f = await app.until((f) => f.includes("Type your answer here (Enter for Acme Inc)"))
    expect(f).toContain("Company")
    expect(f).not.toContain("Working…")
    await app.input.typeText("Acme")
    await app.until((f) => f.includes("Acme") && !f.includes("Type your answer here"))
    app.input.pressEnter()
    await until(() => child.answers.length === 1)
    expect(child.answers).toEqual(["Acme"])
    f = await app.until((f) => f.includes("Working…"))
    expect(f).toContain("Company → Acme")
    expect(f).not.toContain("Acme Inc")

    child.push({ type: "ask", question: "Your name", default: "Ngoc" })
    await app.until((f) => f.includes("Type your answer here (Enter for Ngoc)"))
    app.input.pressEnter()
    await until(() => child.answers.length === 2)
    // The input starts empty; the install takes the default for an empty answer.
    expect(child.answers[1]).toBe("")
    await app.until((f) => f.includes("Your name → Ngoc"))
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
    await app.until((f) => f.includes("Company repo") && f.includes("Type your answer here"))
    await app.input.typeText(url)
    app.input.pressEnter()
    await until(() => child.answers.length === 1)
    expect(child.answers).toEqual([url])
    const f = await app.until((f) => f.includes("Working…"))
    expect(f).toContain("Company repo → https://***@github.com/a/b.git")
    expect(f).not.toContain("ghp_sentinel42")
    child.end(0)
    await app.task
    expect(app.out()).toBe("Company repo: https://***@github.com/a/b.git\n")
  } finally {
    await app.stop()
  }
})

test("a choice is the question card, starting on its default; Down and Enter pick the next", async () => {
  const { child, app } = await boot()
  try {
    const options = ["azure", "anthropic", "openai"]
    child.push({ type: "choose", question: "Model provider", options, default: "anthropic" })
    const f = await app.until((f) => f.includes("Model provider") && f.includes("3. openai"))
    expect(f).toContain("1. azure")
    expect(f).toContain("enter submit")
    // Not typed: no box to type in.
    expect(f).not.toContain("Type your answer here")
    app.input.pressArrow("down")
    app.input.pressEnter()
    await until(() => child.answers.length === 1)
    expect(child.answers).toEqual(["openai"])
    const after = await app.until((f) => f.includes("Working…"))
    expect(after).toContain("Model provider → openai")
    expect(after).not.toContain("azure")
    child.end(0)
    await app.task
    expect(app.out()).toBe("Model provider: openai\n")
  } finally {
    await app.stop()
  }
})

test("Ctrl+X is no leader in setup: the next key still picks", async () => {
  const { child, app } = await boot()
  try {
    child.push({ type: "choose", question: "Model provider", options: ["azure", "anthropic", "openai"] })
    await app.until((f) => f.includes("3. openai"))
    app.input.pressKey("x", { ctrl: true })
    app.input.pressKey("2")
    await until(() => child.answers.length === 1)
    expect(child.answers).toEqual(["anthropic"])
  } finally {
    await app.stop()
  }
})

test("a typed choice ends with the inline box; text typed and Enter at once are sent whole", async () => {
  const { child, app } = await boot()
  const first = "claude-sonnet-4-5 (the default)"
  try {
    child.push({ type: "choose", question: "Model", options: [first], default: first, typed: true })
    await app.until((f) => f.includes("1. " + first) && f.includes("2. Type your answer here"))
    app.input.pressArrow("down")
    // Digits go into the box too; Enter comes with no frame in between.
    await app.input.typeText("claude-opus-4-1")
    app.input.pressEnter()
    await until(() => child.answers.length === 1)
    expect(child.answers).toEqual(["claude-opus-4-1"])
    await app.until((f) => f.includes("Model → claude-opus-4-1"))
    child.end(0)
    await app.task
    expect(app.out()).toBe("Model: claude-opus-4-1\n")
  } finally {
    await app.stop()
  }
})

test("the box is one line: a pasted line break adds nothing", async () => {
  const { child, app } = await boot()
  try {
    child.push({ type: "choose", question: "Remote", options: ["None for now"], default: "None for now", typed: true })
    await app.until((f) => f.includes("2. Type your answer here"))
    app.input.pressArrow("down")
    await app.input.pasteBracketedText("git@example.com:\na.git")
    await app.until((f) => f.includes("2. git@example.com:a.git"))
    app.input.pressEnter()
    await until(() => child.answers.length === 1)
    expect(child.answers).toEqual(["git@example.com:a.git"])
  } finally {
    await app.stop()
  }
})

test("an empty box sends nothing; Up leaves it for the options", async () => {
  const { child, app } = await boot()
  try {
    child.push({ type: "choose", question: "Remote", options: ["None for now"], default: "None for now", typed: true })
    await app.until((f) => f.includes("2. Type your answer here"))
    app.input.pressArrow("down")
    app.input.pressEnter()
    await Bun.sleep(100)
    expect(child.answers).toEqual([])
    app.input.pressArrow("up")
    app.input.pressEnter()
    await until(() => child.answers.length === 1)
    expect(child.answers).toEqual(["None for now"])
  } finally {
    await app.stop()
  }
})

test("a typed URL is sent whole but shown without its user and password", async () => {
  const { child, app } = await boot()
  const url = "https://x-access-token:ghp_sentinel42@github.com/a/b.git"
  try {
    child.push({ type: "choose", question: "Remote", options: ["None for now"], default: "None for now", typed: true })
    await app.until((f) => f.includes("2. Type your answer here"))
    app.input.pressArrow("down")
    await app.input.typeText(url)
    app.input.pressEnter()
    await until(() => child.answers.length === 1)
    expect(child.answers).toEqual([url])
    const f = await app.until((f) => f.includes("Working…"))
    expect(f).toContain("Remote → https://***@github.com/a/b.git")
    expect(f).not.toContain("ghp_sentinel42")
    child.end(0)
    await app.task
    expect(app.out()).toBe("Remote: https://***@github.com/a/b.git\n")
  } finally {
    await app.stop()
  }
})

test("Esc does nothing on the card; Ctrl-C stops the install even from the box", async () => {
  const { child, app } = await boot()
  try {
    child.push({ type: "choose", question: "Remote", options: ["None for now"], default: "None for now", typed: true })
    await app.until((f) => f.includes("2. Type your answer here"))
    app.input.pressEscape()
    await Bun.sleep(100)
    expect(app.frame()).toContain("2. Type your answer here")
    app.input.pressArrow("down")
    await app.input.typeText("abc")
    await app.until((f) => f.includes("2. abc"))
    app.input.pressCtrlC()
    const f = await app.until((f) => f.includes("Stopping…"))
    expect(f).not.toContain("2. abc")
    expect(child.interrupts).toBe(1)
    expect(child.answers).toEqual([])
  } finally {
    await app.stop()
  }
})

test("a long list shows a window that follows the cursor", async () => {
  const { child, app } = await boot()
  const options = Array.from({ length: 40 }, (_, i) => `opt-${String(i + 1).padStart(2, "0")}`)
  try {
    child.push({ type: "say", text: "Pick one." })
    child.push({ type: "choose", question: "Deployment", options })
    await app.until((f) => f.includes("1. opt-01"))
    for (let i = 0; i < 39; i++) app.input.pressArrow("down")
    const f = await app.until((f) => f.includes("40. opt-40"))
    expect(f).not.toContain("opt-01")
    expect(f).toContain("Pick one.")
    app.input.pressEnter()
    await until(() => child.answers.length === 1)
    expect(child.answers).toEqual(["opt-40"])
  } finally {
    await app.stop()
  }
})

test("a typed default that isn't an option starts in the box, so Enter sends it", async () => {
  const { child, app } = await boot()
  try {
    child.push({ type: "choose", question: "Model", options: ["sonnet (the default)"], default: "my-model", typed: true })
    await app.until((f) => f.includes("2. my-model"))
    app.input.pressEnter()
    await until(() => child.answers.length === 1)
    expect(child.answers).toEqual(["my-model"])
  } finally {
    await app.stop()
  }
})

test("a long option wraps instead of being cut", async () => {
  const { child, app } = await boot()
  const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ")
  try {
    child.push({ type: "choose", question: "Plan", options: [long, "short"] })
    const f = await app.until((f) => f.includes("word29") && f.includes("2. short"))
    expect(f).toContain("1. word0")
    // Only the option's own lines: other text on screen may hold an ellipsis.
    expect(f.split("\n").filter((l) => /word\d/.test(l)).some((l) => l.includes("…"))).toBe(false)
  } finally {
    await app.stop()
  }
})

test("a secret shows only as dots and is never shown or printed", async () => {
  const { child, app } = await boot()
  try {
    child.push({ type: "secret", question: "API key" })
    await app.until((f) => f.includes("API key") && f.includes("Paste or type it here; it isn't shown"))
    await app.input.typeText(SECRET)
    const typed = await app.until((f) => f.includes("•".repeat(28)))
    expect(typed).not.toContain("Paste or type it here")
    expect(typed).not.toContain("sentinel")
    app.input.pressEnter()
    await until(() => child.answers.length === 1)
    expect(child.answers).toEqual([SECRET])
    const f = await app.until((f) => f.includes("Working…"))
    expect(f).toContain("API key → (hidden)")
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
    await app.until((f) => f.includes("(Enter for Acme)"))
    app.input.pressEnter()
    let f = await app.until((f) => f.includes("Working…"))
    expect(spinning(f)).toBe(true)
    child.push({ type: "ask", question: "Your name", default: "" })
    f = await app.until((f) => f.includes("Your name"))
    expect(f).not.toContain("Working…")
  } finally {
    await app.stop()
  }
})

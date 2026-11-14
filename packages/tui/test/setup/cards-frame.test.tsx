// The setup screen's cards: a command to approve, how it ended, files to review before saving, and the terminal
// handed to ssh and taken back.
import { expect, test } from "bun:test"
import { until } from "../fixture/until"
import { bootSetup, FakeChild } from "./boot"

const WARNING =
  "Careful: this names /h/hq, provider.json or auth.json, which hold the model's key or its ChatGPT sign-in; what reads them reaches the model."

test("a command shows its title, the warning and its numbered lines above the question to run it", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child, "opencorp hq")
  try {
    child.push({
      type: "command",
      title: "The model wants to run a command: read the model's settings",
      warning: WARNING,
      lines: ["  1  cat provider.json", "  2  echo jobs<U+00A0># ; touch x"],
    })
    child.push({ type: "choose", question: "Run this 2-line command?", options: ["Run it", "Don't run it"], default: "Don't run it" })
    // Short enough to fit, so its choices are there at once; the default is "Don't run it".
    const f = await app.until((f) => f.includes("Run this 2-line command?") && f.includes("Don't run it"))
    expect(f).toContain("The model wants to run a command: read the model's settings")
    expect(f).toContain("Careful: this names /h/hq, provider.json or auth.json")
    expect(f).toContain("1  cat provider.json")
    expect(f).toContain("2  echo jobs<U+00A0># ; touch x")
    expect(f).toContain("Run it")
    expect(f).toContain("❯ Don't run it")
    child.end(0)
    await app.task
    expect(app.out()).toBe(
      [
        "The model wants to run a command: read the model's settings",
        WARNING,
        "  1  cat provider.json",
        "  2  echo jobs<U+00A0># ; touch x",
        "",
      ].join("\n"),
    )
  } finally {
    await app.stop()
  }
})

test("a long command line wraps rather than being cut, so all of it shows", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child)
  const tail = "; touch /tmp/hidden-at-the-end"
  try {
    child.push({ type: "command", title: "The model wants to run a command: look", lines: ["  1  " + "x".repeat(120) + tail] })
    const f = await app.until((f) => f.includes("look"))
    expect(f.replace(/\s+/g, "")).toContain(tail.replace(/\s+/g, ""))
  } finally {
    await app.stop()
  }
})

test("a result shows how the command ended and the last lines it printed; the transcript keeps only how", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child)
  try {
    child.push({ type: "result", title: "Exited 4", ok: false, lines: ["out", "err"] })
    child.push({ type: "result", title: "Exited 0", ok: true, lines: [] })
    const f = await app.until((f) => f.includes("Exited 0"))
    expect(f).toContain("Exited 4")
    expect(f).toMatch(/out\s*\n.*err/)
    child.end(0)
    await app.task
    expect(app.out()).toBe("Exited 4\nExited 0\n")
  } finally {
    await app.stop()
  }
})

test("the save view shows each file numbered under its name, the risks and the warning, then the question", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child, "opencorp hq")
  try {
    child.push({
      type: "review",
      title: "The model wants to save how this machine reaches HQ.",
      files: [
        { name: "/h/hq/reach.sh, which runs on every visit", lines: ["  1  set -eu", "  2  ssh login1 true"] },
        { name: "/h/hq/notes.md", lines: ["  1  Through login1."] },
      ],
      risks: ["The script runs now and on every visit.", "The login node may be shared."],
      warning: WARNING,
    })
    const question = "Save this 2-line reach.sh and the notes, after testing the whole connection?"
    child.push({ type: "choose", question, options: ["Test it, then save it", "Don't save it"], default: "Don't save it" })
    const f = await app.until((f) => f.includes("Don't save it"))
    for (const text of [
      "The model wants to save how this machine reaches HQ.",
      "/h/hq/reach.sh, which runs on every visit",
      "2  ssh login1 true",
      "/h/hq/notes.md",
      "1  Through login1.",
      "Before you save it:",
      "- The script runs now and on every visit.",
      "- The login node may be shared.",
      "Careful: this names /h/hq",
      question,
      "Test it, then save it",
      "❯ Don't save it",
    ])
      expect(f).toContain(text)
    child.end(0)
    await app.task
    expect(app.out()).toBe(
      [
        "The model wants to save how this machine reaches HQ.",
        "/h/hq/reach.sh, which runs on every visit:",
        "  1  set -eu",
        "  2  ssh login1 true",
        "/h/hq/notes.md:",
        "  1  Through login1.",
        "Before you save it:",
        "  - The script runs now and on every visit.",
        "  - The login node may be shared.",
        WARNING,
        "",
      ].join("\n"),
    )
  } finally {
    await app.stop()
  }
})

test("handing the terminal over suspends the screen, says why on the terminal and answers; taking it back resumes", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child, "opencorp hq")
  const renderer = app.setup.renderer
  const calls: string[] = []
  for (const name of ["suspend", "resume"] as const) {
    const original = renderer[name].bind(renderer)
    renderer[name] = () => {
      calls.push(name)
      original()
    }
  }
  try {
    await app.until((f) => f.includes("Working…"))
    const why = "Running the command. SSH asks here for any password, Duo or host key."
    child.push({ type: "hand_over", why })
    await until(() => child.answers.length === 1)
    expect(child.answers).toEqual([""])
    expect(calls).toEqual(["suspend"])
    expect(app.err()).toBe(`\n${why}\n`)
    // No key reaches the screen while ssh has the terminal.
    app.input.pressCtrlC()
    expect(child.interrupts).toBe(0)
    child.push({ type: "take_back" })
    expect(calls).toEqual(["suspend", "resume"])
    const f = await app.until((f) => f.includes(why))
    expect(f).toContain("Working…")
    child.end(0)
    await app.task
    // The terminal said why already.
    expect(app.out()).toBe("")
  } finally {
    await app.stop()
  }
})

/** How onboarding and `opencorp hq` show text from programs and models. */
import { expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { type Card, cardLines, clean, TtyPrompter } from "../../src/install/prompts.ts"

test("clean shows bidi controls and other invisible format characters escaped", () => {
  expect(clean("a‪b‮c⁦d⁩e")).toBe("a<U+202A>b<U+202E>c<U+2066>d<U+2069>e")
  expect(clean("x​y‍z﻿­؜")).toBe("x<U+200B>y<U+200D>z<U+FEFF><U+00AD><U+061C>")
  expect(clean("\u{e0041}")).toBe("<U+E0041>")
  // Line breaks still become spaces, and other control characters still go.
  expect(clean("a\nb\x1b[2Jc")).toBe("a b[2Jc")
})

test("on the terminal a command shows its title, warning and lines; a review its files and risks; a result nothing", () => {
  const command = {
    type: "command",
    title: "The model wants to run a command: look",
    warning: "Careful",
    lines: ["  1  ls"],
  } satisfies Card
  expect(cardLines(command)).toEqual(["The model wants to run a command: look", "Careful", "  1  ls"])
  expect(cardLines({ ...command, warning: "" })).toEqual(["The model wants to run a command: look", "  1  ls"])
  // The terminal showed the output as it came, so only how it ended (or why a test failed) is printed.
  expect(cardLines({ type: "result", title: "Exited 0", ok: true, lines: ["a"] })).toEqual(["Exited 0"])
  expect(cardLines({ type: "result", title: "Not saved: reach.sh failed the test", ok: false })).toEqual([
    "Not saved: reach.sh failed the test",
  ])
  const review = {
    type: "review",
    title: "The model wants to save how this machine reaches HQ.",
    files: [
      { name: "/h/hq/reach.sh, which runs on every visit", lines: ["  1  true"] },
      { name: "/h/hq/notes.md", lines: ["  1  Notes"] },
    ],
    risks: ["It runs on every visit."],
    warning: "Careful",
  } satisfies Card
  expect(cardLines(review)).toEqual([
    "The model wants to save how this machine reaches HQ.",
    "/h/hq/reach.sh, which runs on every visit:",
    "  1  true",
    "/h/hq/notes.md:",
    "  1  Notes",
    "Before you save it:",
    "  - It runs on every visit.",
    "Careful",
  ])
})

test("the terminal prompter says a card's lines, and handing the terminal over and back does nothing", async () => {
  const output = new PassThrough()
  let text = ""
  output.on("data", (c) => (text += c))
  const p = new TtyPrompter({ input: new PassThrough(), output, env: {} })
  p.show({ type: "command", title: "Run it?", lines: ["  1  ls"] })
  await p.handOver("Running it.")
  p.takeBack()
  expect(text).toBe("Run it?\n  1  ls\n")
})

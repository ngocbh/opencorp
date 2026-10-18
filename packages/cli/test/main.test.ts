import { expect, test } from "bun:test"
import { commands, main } from "../src/main"
import { parseTuiArgs } from "../src/commands/tui"

/** Runs `main(argv)`, capturing what it writes to stdout and stderr. */
async function capture(argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const log = console.log
  const error = console.error
  console.log = (...a: unknown[]) => void out.push(a.join(" "))
  console.error = (...a: unknown[]) => void err.push(a.join(" "))
  try {
    return { code: await main(argv), out: out.join("\n"), err: err.join("\n") }
  } finally {
    console.log = log
    console.error = error
  }
}

test("--help lists every command; an unknown command exits 2", async () => {
  const help = await capture(["--help"])
  expect(help.code).toBe(0)
  for (const name of Object.keys(commands)) expect(help.out).toContain(name)
  const unknown = await capture(["frobnicate"])
  expect(unknown.code).toBe(2)
  expect(unknown.err).toContain("unknown command: frobnicate")
})

test("the TUI's flags become its args", () => {
  expect(parseTuiArgs([])).toEqual({})
  expect(parseTuiArgs(["-s", "S1", "--person", "minh"])).toEqual({ sessionID: "S1", person: "minh" })
  expect(parseTuiArgs(["--continue", "--prompt", "hi"])).toEqual({ continue: true, prompt: "hi" })
  expect(parseTuiArgs(["-c"])).toEqual({ continue: true })
})

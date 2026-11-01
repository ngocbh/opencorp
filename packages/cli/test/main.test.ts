import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { commands, main } from "../src/main"
import { parseTuiArgs, TUI_USAGE } from "../src/commands/tui"
import pkg from "../package.json" with { type: "json" }

// An empty home: a command that reaches for the office exits 3 here instead of passing a help test.
let home: string
let savedHome: string | undefined
beforeEach(() => {
  savedHome = process.env.OPENCORP_HOME
  home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-main-"))
  process.env.OPENCORP_HOME = home
})
afterEach(() => {
  if (savedHome === undefined) delete process.env.OPENCORP_HOME
  else process.env.OPENCORP_HOME = savedHome
  fs.rmSync(home, { recursive: true, force: true })
})

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
  expect(help.out).toContain("Usage: opencorp [command] [options]")
  expect(help.out).toContain("With no command, or only options, opencorp runs `tui`.")
  expect(Object.keys(commands)).toContain("pair")
  expect(Object.keys(commands)).toContain("stop")
  for (const name of Object.keys(commands)) expect(help.out).toContain(name)
  const unknown = await capture(["frobnicate"])
  expect(unknown.code).toBe(2)
  expect(unknown.err).toContain("opencorp: unknown command: frobnicate")
})

test("there is no feedback command", async () => {
  expect(commands.feedback).toBeUndefined()
  expect((await capture(["feedback"])).code).toBe(2)
})

test("an inherited name is an unknown command", async () => {
  for (const name of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
    const result = await capture([name])
    expect(result.code).toBe(2)
    expect(result.err).toContain(`opencorp: unknown command: ${name}`)
  }
})

/** Each client command and the start of the usage its --help prints. */
const USAGES: Record<string, string> = {
  tui: "usage: opencorp [tui] [-s ID] [-c] [--person HANDLE] [--prompt TEXT]",
  end: "usage: opencorp end [SESSION_ID]",
  profile: "Usage: opencorp profile edit PERSON",
  login: "usage: opencorp login [--handle H] [--device NAME] [--force]",
  password: "usage: opencorp password [--handle H]",
  logout: "usage: opencorp logout",
  devices: "usage: opencorp devices list [HANDLE] [--hashes]",
  whoami: "usage: opencorp whoami",
  pair: "usage: opencorp pair [--handle HANDLE] [--no-open]",
}

test("each client command prints its usage on --help or -h, without the office", async () => {
  for (const [name, usage] of Object.entries(USAGES))
    for (const flag of ["--help", "-h"]) {
      const result = await capture([name, flag])
      expect({ name, flag, code: result.code, err: result.err }).toEqual({ name, flag, code: 0, err: "" })
      expect(result.out).toStartWith(usage)
    }
  // After `--`, --help is an argument, which whoami takes none of.
  expect((await capture(["whoami", "--", "--help"])).code).toBe(2)
})

test("help COMMAND prints that command's usage; an unknown one exits 2", async () => {
  const whoami = await capture(["help", "whoami"])
  expect(whoami.code).toBe(0)
  expect(whoami.out).toBe(USAGES.whoami)
  for (const name of ["nosuch", "constructor"]) {
    const unknown = await capture(["help", name])
    expect(unknown.code).toBe(2)
    expect(unknown.err).toContain(`opencorp: unknown command: ${name}`)
  }
  for (const argv of [["help"], ["help", "help"], ["help", "-h"], ["help", "--help"]]) {
    const general = await capture(argv)
    expect(general.code).toBe(0)
    expect(general.out).toContain("Usage: opencorp [command] [options]")
  }
})

test("--version prints the package's version", async () => {
  const result = await capture(["--version"])
  expect(result).toEqual({ code: 0, out: pkg.version, err: "" })
})

test("the help shows each command's arguments, the TUI's options and the home's variable", async () => {
  const help = (await capture(["--help"])).out
  for (const line of TUI_USAGE.split("\n").slice(1)) expect(help).toContain(line)
  for (const text of ["end [SESSION_ID]", "profile edit PERSON", "opencorp help COMMAND", "--version", "OPENCORP_HOME"])
    expect(help).toContain(text)
})

test("the TUI's flags become its args", () => {
  expect(parseTuiArgs([])).toEqual({})
  expect(parseTuiArgs(["-h"])).toEqual({ help: true })
  expect(parseTuiArgs(["--prompt=--help"])).toEqual({ prompt: "--help" })
  expect(parseTuiArgs(["-s", "S1", "--person", "minh"])).toEqual({ sessionID: "S1", person: "minh" })
  expect(parseTuiArgs(["--continue", "--prompt", "hi"])).toEqual({ continue: true, prompt: "hi" })
  expect(parseTuiArgs(["-c"])).toEqual({ continue: true })
})

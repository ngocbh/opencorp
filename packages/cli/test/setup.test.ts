import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { selfCommand } from "@opencorp/office/platform"
import { type SetupDeps, drawable, setUp } from "../src/setup"

const HOME_DIR = fs.realpathSync(os.homedir())

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

/** SetupDeps whose install exits `code`, on a terminal it can draw on or not; the office exits 7. Each records what
 *  it got. */
function fake(opts: { code?: number; terminal?: boolean; spawnCwd?: () => string } = {}) {
  const calls: { argv: string[]; cwd: string }[] = []
  const offices: (string | undefined)[] = []
  const deps: SetupDeps = {
    spawn: async (argv, { cwd }) => {
      calls.push({ argv, cwd })
      return opts.code ?? 0
    },
    spawnCwd: opts.spawnCwd ?? (() => HOME_DIR),
    terminal: () => opts.terminal ?? true,
    openOffice: async () => {
      offices.push(process.env.OPENCORP_HOME)
      return 7
    },
  }
  return { deps, calls, offices }
}

const COMMANDS = ["init", "onboard"] as const
const install = (command: string, ...argv: string[]) => [...selfCommand(), "install", command, ...argv]

test("init and onboard run the install on this terminal, then open the office where it draws", async () => {
  for (const command of COMMANDS) {
    const { deps, calls, offices } = fake()
    expect(await setUp(command, ["--service", "tmux"], deps)).toBe(7)
    expect(calls).toEqual([{ argv: install(command, "--service", "tmux"), cwd: HOME_DIR }])
    expect(offices).toHaveLength(1)
  }
})

test("--provider-stdin or no drawable terminal opens no office", async () => {
  for (const command of COMMANDS) {
    const piped = fake({ code: 4 })
    expect(await setUp(command, ["--service", "tmux", "--provider-stdin"], piped.deps)).toBe(4)
    expect(piped.calls).toEqual([{ argv: install(command, "--service", "tmux", "--provider-stdin"), cwd: HOME_DIR }])
    expect(piped.offices).toEqual([])
    const undrawn = fake({ terminal: false, code: 5 })
    expect(await setUp(command, ["--service", "background"], undrawn.deps)).toBe(5)
    expect(undrawn.calls).toEqual([{ argv: install(command, "--service", "background"), cwd: HOME_DIR }])
    expect(undrawn.offices).toEqual([])
  }
})

for (const command of COMMANDS) {
  describe(`opencorp ${command}`, () => {
    for (const flag of ["-h", "--help"]) {
      test(`with ${flag}, runs the install on this terminal and opens no office`, async () => {
        const { deps, calls, offices } = fake({ code: 4 })
        expect(await setUp(command, ["--service", "tmux", flag], deps)).toBe(4)
        expect(calls).toEqual([{ argv: install(command, "--service", "tmux", flag), cwd: HOME_DIR }])
        expect(offices).toEqual([])
      })
    }

    test("an install that exits non-zero returns its code and opens no office", async () => {
      const { deps, offices } = fake({ code: 130 })
      expect(await setUp(command, [], deps)).toBe(130)
      expect(offices).toEqual([])
    })

    test("--home reaches the install absolute and names the office that opens", async () => {
      process.env.OPENCORP_HOME = "/tmp/elsewhere"
      const rel = path.resolve(process.cwd(), "rel")
      for (const [argv, given, home] of [
        [["--home", "/tmp/h"], ["--home", "/tmp/h"], "/tmp/h"],
        [["--home=/tmp/h"], ["--home=/tmp/h"], "/tmp/h"],
        [["--home", "rel"], ["--home", rel], rel],
      ] as [string[], string[], string][]) {
        const { deps, calls, offices } = fake()
        expect(await setUp(command, argv, deps)).toBe(7)
        expect(calls.map((c) => c.argv)).toEqual([install(command, ...given)])
        expect(offices).toEqual([home])
      }
    })

    test("a missing home folder is one line and exit 1, and opens no office", async () => {
      const { deps, calls, offices } = fake({
        spawnCwd: () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
        },
      })
      const err: string[] = []
      const error = console.error
      console.error = (...a: unknown[]) => void err.push(a.join(" "))
      try {
        expect(await setUp(command, [], deps)).toBe(1)
      } finally {
        console.error = error
      }
      expect(err).toEqual([`opencorp ${command}: your home folder ${os.homedir()} doesn't exist`])
      expect(calls).toEqual([])
      expect(offices).toEqual([])
    })

    test("without --home, or with an empty one, OPENCORP_HOME is left as it was", async () => {
      process.env.OPENCORP_HOME = "/tmp/elsewhere"
      const set = fake()
      await setUp(command, ["--service", "tmux"], set.deps)
      expect(set.offices).toEqual(["/tmp/elsewhere"])
      const empty = fake()
      await setUp(command, ["--home="], empty.deps)
      expect(empty.offices).toEqual(["/tmp/elsewhere"])
      delete process.env.OPENCORP_HOME
      const unset = fake()
      await setUp(command, [], unset.deps)
      expect(unset.offices).toEqual([undefined])
    })
  })
}

test("the TUI draws on a terminal whose TERM moves the cursor, with stdin and stdout both TTYs", () => {
  expect(drawable({ TERM: "xterm-256color" }, true, true)).toBe(true)
  expect(drawable({ TERM: "dumb" }, true, true)).toBe(false)
  expect(drawable({}, true, true)).toBe(false)
  expect(drawable({ TERM: "xterm-256color" }, false, true)).toBe(false)
  expect(drawable({ TERM: "xterm-256color" }, true, false)).toBe(false)
})

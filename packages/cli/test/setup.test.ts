import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { selfCommand } from "@opencorp/office/platform"
import { type SetupDeps, drawable, setUp } from "../src/setup"

// The home folder the commands get, in place of the real one: the install runs in it.
const HOME_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-setup-")))
afterAll(() => fs.rmSync(HOME_DIR, { recursive: true, force: true }))

/** SetupDeps whose install exits `code`, on a terminal it can draw on or not; the office exits 7. Each records what
 *  it got: the install's argv and folder in `calls`, its env in `envs`, and the office home it opened in `offices`. */
function fake(opts: { code?: number; terminal?: boolean } = {}) {
  const calls: { argv: string[]; cwd: string }[] = []
  const envs: Record<string, string>[] = []
  const offices: (string | undefined)[] = []
  const deps: SetupDeps = {
    spawn: async (argv, { cwd, env }) => {
      calls.push({ argv, cwd })
      envs.push(env)
      return opts.code ?? 0
    },
    terminal: () => opts.terminal ?? true,
    openOffice: async (env) => {
      offices.push(env.OPENCORP_HOME)
      return 7
    },
  }
  return { deps, calls, envs, offices }
}

/** The env the commands run with: `HOME_DIR` as HOME, and `more`. */
const env = (more: Record<string, string> = {}) => ({ HOME: HOME_DIR, ...more })

const COMMANDS = ["init", "onboard"] as const
const install = (command: string, ...argv: string[]) => [...selfCommand(), "install", command, ...argv]

test("init and onboard run the install on this terminal, then open the office where it draws", async () => {
  for (const command of COMMANDS) {
    const { deps, calls, offices } = fake()
    expect(await setUp(command, ["--service", "tmux"], env(), deps)).toBe(7)
    expect(calls).toEqual([{ argv: install(command, "--service", "tmux"), cwd: HOME_DIR }])
    expect(offices).toHaveLength(1)
  }
})

test("--provider-stdin or no drawable terminal opens no office", async () => {
  for (const command of COMMANDS) {
    const piped = fake({ code: 4 })
    expect(await setUp(command, ["--service", "tmux", "--provider-stdin"], env(), piped.deps)).toBe(4)
    expect(piped.calls).toEqual([{ argv: install(command, "--service", "tmux", "--provider-stdin"), cwd: HOME_DIR }])
    expect(piped.offices).toEqual([])
    const undrawn = fake({ terminal: false, code: 5 })
    expect(await setUp(command, ["--service", "background"], env(), undrawn.deps)).toBe(5)
    expect(undrawn.calls).toEqual([{ argv: install(command, "--service", "background"), cwd: HOME_DIR }])
    expect(undrawn.offices).toEqual([])
  }
})

for (const command of COMMANDS) {
  describe(`opencorp ${command}`, () => {
    for (const flag of ["-h", "--help"]) {
      test(`with ${flag}, runs the install on this terminal and opens no office`, async () => {
        const { deps, calls, offices } = fake({ code: 4 })
        expect(await setUp(command, ["--service", "tmux", flag], env(), deps)).toBe(4)
        expect(calls).toEqual([{ argv: install(command, "--service", "tmux", flag), cwd: HOME_DIR }])
        expect(offices).toEqual([])
      })
    }

    test("an install that exits non-zero returns its code and opens no office", async () => {
      const { deps, offices } = fake({ code: 130 })
      expect(await setUp(command, [], env(), deps)).toBe(130)
      expect(offices).toEqual([])
    })

    // The install's env stays the caller's: init's chat points its own TUI at --home (chat.ts), and the install says to
    // export OPENCORP_HOME when this shell's `opencorp` would look for its office elsewhere.
    test("--home reaches the install absolute and names the office that opens; the install's OPENCORP_HOME stays the caller's", async () => {
      const rel = path.resolve(process.cwd(), "rel")
      for (const [argv, given, home] of [
        [["--home", "/tmp/h"], ["--home", "/tmp/h"], "/tmp/h"],
        [["--home=/tmp/h"], ["--home=/tmp/h"], "/tmp/h"],
        [["--home", "rel"], ["--home", rel], rel],
      ] as [string[], string[], string][]) {
        // The office that opens gets --home as its OPENCORP_HOME.
        const { deps, calls, envs, offices } = fake()
        expect(await setUp(command, argv, env({ OPENCORP_HOME: "/tmp/elsewhere" }), deps)).toBe(7)
        expect(calls.map((c) => c.argv)).toEqual([install(command, ...given)])
        expect(envs.map((env) => env.OPENCORP_HOME)).toEqual(["/tmp/elsewhere"])
        expect(offices).toEqual([home])
      }
    })

    test("a missing home folder is one line and exit 1, and opens no office", async () => {
      const { deps, calls, offices } = fake()
      const missing = path.join(HOME_DIR, "missing")
      const err: string[] = []
      const error = console.error
      console.error = (...a: unknown[]) => void err.push(a.join(" "))
      try {
        expect(await setUp(command, [], { HOME: missing }, deps)).toBe(1)
      } finally {
        console.error = error
      }
      expect(err).toEqual([`opencorp ${command}: your home folder ${missing} doesn't exist`])
      expect(calls).toEqual([])
      expect(offices).toEqual([])
    })

    test("without --home, or with an empty one, OPENCORP_HOME is left as it was", async () => {
      const elsewhere = env({ OPENCORP_HOME: "/tmp/elsewhere" })
      const set = fake()
      await setUp(command, ["--service", "tmux"], elsewhere, set.deps)
      expect(set.offices).toEqual(["/tmp/elsewhere"])
      const empty = fake()
      await setUp(command, ["--home="], elsewhere, empty.deps)
      expect(empty.offices).toEqual(["/tmp/elsewhere"])
      const unset = fake()
      await setUp(command, [], env(), unset.deps)
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

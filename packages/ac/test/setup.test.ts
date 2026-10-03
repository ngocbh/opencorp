import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { REPO, venvPython } from "../src/office"
import { type SetupDeps, drawable, setUp } from "../src/setup"

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

/**
 * SetupDeps whose programs all exist and exit `codes[program]` (0 if absent), on a terminal or not; the screen exits
 * `screenCode` (or throws `screenThrows`) and the office exits 7, each recording what it got.
 */
function fake(opts: { codes?: Record<string, number>; terminal?: boolean; screenCode?: number; screenThrows?: Error } = {}) {
  const calls: { argv: string[]; cwd?: string }[] = []
  const screens: string[][] = []
  const offices: (string | undefined)[] = []
  const errors: string[] = []
  const deps: SetupDeps = {
    exists: () => true,
    which: (cmd) => `/bin/${cmd}`,
    spawn: async (argv, cwd) => {
      calls.push({ argv, cwd })
      return opts.codes?.[path.basename(argv[0])] ?? 0
    },
    error: (m) => void errors.push(m),
    terminal: () => opts.terminal ?? true,
    screen: async (argv) => {
      screens.push(argv)
      if (opts.screenThrows) throw opts.screenThrows
      return opts.screenCode ?? 0
    },
    openOffice: async () => {
      offices.push(process.env.AGENT_CORP_HOME)
      return 7
    },
  }
  return { deps, calls, screens, offices, errors }
}

const sync = { argv: ["/bin/uv", "sync", "--frozen", "--quiet"], cwd: REPO }

for (const command of ["init", "onboard"] as const) {
  describe(`ac ${command}`, () => {
    const install = (...argv: string[]) => [venvPython(), "-m", "agent_corp.install", command, ...argv]

    for (const flag of ["--provider-stdin", "-h", "--help"]) {
      test(`with ${flag}, runs the install on this terminal, without the screen or the office`, async () => {
        const { deps, calls, screens, offices } = fake({ codes: { python: 4 } })
        expect(await setUp(command, ["--service", "tmux", flag], deps)).toBe(4)
        expect(calls).toEqual([sync, { argv: install("--service", "tmux", flag), cwd: undefined }])
        expect(screens).toEqual([])
        expect(offices).toEqual([])
      })
    }

    test("without a terminal, runs the install as given and returns its exit code", async () => {
      const { deps, calls, screens, offices } = fake({ terminal: false, codes: { python: 5 } })
      expect(await setUp(command, ["--service", "background"], deps)).toBe(5)
      expect(calls).toEqual([sync, { argv: install("--service", "background"), cwd: undefined }])
      expect(screens).toEqual([])
      expect(offices).toEqual([])
    })

    test("on a terminal, syncs the venv, then runs the install with --json-prompts behind the screen", async () => {
      const { deps, calls, screens } = fake()
      await setUp(command, ["--service", "tmux"], deps)
      expect(calls).toEqual([sync])
      expect(screens).toEqual([install("--json-prompts", "--service", "tmux")])
    })

    test("a screen that exits non-zero returns its code and opens no office", async () => {
      const { deps, offices } = fake({ screenCode: 130 })
      expect(await setUp(command, [], deps)).toBe(130)
      expect(offices).toEqual([])
    })

    test("a screen that exits 0 opens the office and returns its code", async () => {
      const { deps, offices } = fake()
      expect(await setUp(command, [], deps)).toBe(7)
      expect(offices).toHaveLength(1)
    })

    test("a screen that can't start says to pass the provider on stdin and exits 1", async () => {
      const { deps, errors, offices } = fake({ screenThrows: new Error("boom") })
      expect(await setUp(command, [], deps)).toBe(1)
      expect(errors).toEqual([
        `ac ${command}: can't show the setup screen: boom; pass the provider with --provider-stdin instead`,
      ])
      expect(offices).toEqual([])
    })

    test("a failing uv sync returns its code without the screen", async () => {
      const { deps, calls, screens, offices } = fake({ codes: { uv: 2 } })
      expect(await setUp(command, [], deps)).toBe(2)
      expect(calls).toEqual([sync])
      expect(screens).toEqual([])
      expect(offices).toEqual([])
    })

    for (const argv of [["--home", "/tmp/h"], ["--home=/tmp/h"]]) {
      test(`${argv.join(" ")} is passed to the screen and names the office that opens`, async () => {
        process.env.AGENT_CORP_HOME = "/tmp/elsewhere"
        const { deps, screens, offices } = fake()
        expect(await setUp(command, argv, deps)).toBe(7)
        expect(screens).toEqual([install("--json-prompts", ...argv)])
        expect(offices).toEqual(["/tmp/h"])
      })
    }

    test("without --home, AGENT_CORP_HOME is left as it was", async () => {
      process.env.AGENT_CORP_HOME = "/tmp/elsewhere"
      const set = fake()
      await setUp(command, ["--service", "tmux"], set.deps)
      expect(set.offices).toEqual(["/tmp/elsewhere"])
      delete process.env.AGENT_CORP_HOME
      const unset = fake()
      await setUp(command, [], unset.deps)
      expect(unset.offices).toEqual([undefined])
    })
  })
}

test("the screen draws on a terminal whose TERM moves the cursor, with stdin and stdout both TTYs", () => {
  expect(drawable({ TERM: "xterm-256color" }, true, true)).toBe(true)
  expect(drawable({ TERM: "dumb" }, true, true)).toBe(false)
  expect(drawable({}, true, true)).toBe(false)
  expect(drawable({ TERM: "xterm-256color" }, false, true)).toBe(false)
  expect(drawable({ TERM: "xterm-256color" }, true, false)).toBe(false)
})

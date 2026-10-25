import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { selfCommand } from "@opencorp/office/platform"
import { type InstallSpec, installSpawn } from "../src/office"
import { type SetupDeps, drawable, setUp } from "../src/setup"

const WRAPPER = path.resolve(import.meta.dir, "../bin/opencorp")
const HOME_DIR = fs.realpathSync(os.homedir())

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

/**
 * SetupDeps whose install exits `code`, on a terminal or not; the screen exits `screenCode` (or throws
 * `screenThrows`) and the office exits 7, each recording what it got.
 */
function fake(
  opts: { code?: number; terminal?: boolean; screenCode?: number; screenThrows?: Error; spawnCwd?: () => string } = {},
) {
  const calls: { argv: string[]; cwd: string }[] = []
  const screens: InstallSpec[] = []
  const offices: (string | undefined)[] = []
  const errors: string[] = []
  const deps: SetupDeps = {
    spawn: async (argv, { cwd }) => {
      calls.push({ argv, cwd })
      return opts.code ?? 0
    },
    spawnCwd: opts.spawnCwd ?? (() => HOME_DIR),
    error: (m) => void errors.push(m),
    terminal: () => opts.terminal ?? true,
    screen: async (spec) => {
      screens.push(spec)
      if (opts.screenThrows) throw opts.screenThrows
      return opts.screenCode ?? 0
    },
    openOffice: async () => {
      offices.push(process.env.OPENCORP_HOME)
      return 7
    },
  }
  return { deps, calls, screens, offices, errors }
}

for (const command of ["init", "onboard"] as const) {
  describe(`opencorp ${command}`, () => {
    const install = (...argv: string[]) => [...selfCommand(), "install", command, ...argv]

    for (const flag of ["--provider-stdin", "-h", "--help"]) {
      test(`with ${flag}, runs the install on this terminal, without the screen or the office`, async () => {
        const { deps, calls, screens, offices } = fake({ code: 4 })
        expect(await setUp(command, ["--service", "tmux", flag], deps)).toBe(4)
        expect(calls).toEqual([{ argv: install("--service", "tmux", flag), cwd: HOME_DIR }])
        expect(screens).toEqual([])
        expect(offices).toEqual([])
      })
    }

    test("without a terminal, runs the install as given and returns its exit code", async () => {
      const { deps, calls, screens, offices } = fake({ terminal: false, code: 5 })
      expect(await setUp(command, ["--service", "background"], deps)).toBe(5)
      expect(calls).toEqual([{ argv: install("--service", "background"), cwd: HOME_DIR }])
      expect(screens).toEqual([])
      expect(offices).toEqual([])
    })

    test("on a terminal, runs the install with --json-prompts behind the screen and spawns nothing itself", async () => {
      const { deps, calls, screens } = fake()
      await setUp(command, ["--service", "tmux"], deps)
      expect(calls).toEqual([])
      expect(screens).toEqual([installSpawn(command, ["--json-prompts", "--service", "tmux"])])
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
        `opencorp ${command}: can't show the setup screen: boom; pass the provider with --provider-stdin instead`,
      ])
      expect(offices).toEqual([])
    })

    test("a missing home folder is one line and exit 1, without the screen", async () => {
      const { deps, screens, offices } = fake({
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
      expect(screens).toEqual([])
      expect(offices).toEqual([])
    })

    for (const argv of [["--home", "/tmp/h"], ["--home=/tmp/h"]]) {
      test(`${argv.join(" ")} is passed to the screen and names the office that opens`, async () => {
        process.env.OPENCORP_HOME = "/tmp/elsewhere"
        const { deps, screens, offices } = fake()
        expect(await setUp(command, argv, deps)).toBe(7)
        expect(screens.map((s) => s.argv)).toEqual([install("--json-prompts", ...argv)])
        expect(offices).toEqual(["/tmp/h"])
      })
    }

    test("a relative --home reaches the screen absolute and names the same folder for the office that opens", async () => {
      const { deps, screens, offices } = fake()
      expect(await setUp(command, ["--home", "rel"], deps)).toBe(7)
      const absolute = path.resolve(process.cwd(), "rel")
      expect(screens.map((s) => s.argv)).toEqual([install("--json-prompts", "--home", absolute)])
      expect(offices).toEqual([absolute])
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

test("the screen draws on a terminal whose TERM moves the cursor, with stdin and stdout both TTYs", () => {
  expect(drawable({ TERM: "xterm-256color" }, true, true)).toBe(true)
  expect(drawable({ TERM: "dumb" }, true, true)).toBe(false)
  expect(drawable({}, true, true)).toBe(false)
  expect(drawable({ TERM: "xterm-256color" }, false, true)).toBe(false)
  expect(drawable({ TERM: "xterm-256color" }, true, false)).toBe(false)
})

test(
  "opencorp init --json-prompts drives the TS setup over its JSON lines",
  async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-init-")))
    const home = path.join(tmp, "h")
    // No terminal: the plain path, which runs the install on these pipes.
    const proc = spawn(WRAPPER, ["init", "--json-prompts", "--home", home], {
      cwd: tmp,
      env: { HOME: tmp, PATH: "/usr/bin:/bin", OPENCORP_BUN: process.execPath },
      stdio: "pipe",
      detached: true,
    })
    try {
      let out = ""
      let err = ""
      proc.stdout.setEncoding("utf8").on("data", (d: string) => (out += d))
      proc.stderr.setEncoding("utf8").on("data", (d: string) => (err += d))
      const exited = new Promise<number | null>((resolve) => proc.on("close", (code) => resolve(code)))
      let read = 0
      /** The next prompt on stdout that isn't a `say`, within 20 s. */
      const next = async (): Promise<Record<string, unknown>> => {
        for (const end = Date.now() + 20_000; ; await Bun.sleep(10)) {
          const lines = out.split("\n").slice(0, -1)
          while (read < lines.length) {
            const line = lines[read++]!
            let prompt
            try {
              prompt = JSON.parse(line)
            } catch {
              throw new Error(`not a JSON line: ${line}\nstdout:\n${out}\nstderr:\n${err}`)
            }
            if (prompt.type !== "say") return prompt
          }
          if (Date.now() > end) throw new Error(`no prompt within 20 s; stdout:\n${out}\nstderr:\n${err}`)
        }
      }
      expect(await next()).toMatchObject({ type: "step", number: 1, title: "Model" })
      const choose = await next()
      expect(choose).toMatchObject({ type: "choose", question: "Model provider" })
      expect(choose.options).toContain("openai")
      proc.stdin.write('{"answer":"openai"}\n')
      expect((await next()).type).toBe("secret")
      proc.stdin.end()
      const code = await Promise.race([exited, Bun.sleep(20_000).then(() => "timed out")])
      expect(code).toBe(1)
      expect(err).toContain("opencorp init: no answer to")
      expect(fs.existsSync(path.join(home, "office", "connections", "office.json"))).toBe(false)
    } finally {
      try {
        process.kill(-proc.pid!, "SIGKILL")
      } catch {}
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  },
  60_000,
)

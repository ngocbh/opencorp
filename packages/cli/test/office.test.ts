import { afterEach, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { selfCommand } from "@opencorp/office/platform"
import { doctor } from "../src/commands/doctor"
import { offboard } from "../src/commands/offboard"
import { restart } from "../src/commands/restart"
import { start } from "../src/commands/start"
import { main } from "../src/main"
import { type Deps, install, installSpawn, officeAnswers, realDeps } from "../src/office"
import { createFakeOffice } from "@opencorp/tui/fake-office"

const WRAPPER = path.resolve(import.meta.dir, "../bin/opencorp")

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

/**
 * Runs the wrapper with `args` in `cwd` with exactly `env` and stdin closed, leading its own process group; resolves
 * to its exit code and output, or fails after 20 s showing what it wrote. The group is killed after, so the install
 * never outlives the test.
 */
async function runWrapper(args: string[], cwd: string, env: Record<string, string>) {
  const proc = spawn(WRAPPER, args, { cwd, env, stdio: "pipe", detached: true })
  let stdout = ""
  let stderr = ""
  proc.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d))
  proc.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d))
  proc.stdin.end()
  try {
    const exited = new Promise<number | null>((resolve) => proc.on("close", (code) => resolve(code)))
    const code = await Promise.race([exited, Bun.sleep(20_000).then(() => "timed out" as const)])
    if (code === "timed out") throw new Error(`no exit within 20 s; stdout:\n${stdout}\nstderr:\n${stderr}`)
    return { code, stdout, stderr }
  } finally {
    try {
      process.kill(-proc.pid!, "SIGKILL")
    } catch {}
  }
}

/** Deps whose spawn records each call and resolves to `code`, run in the real home dir. */
function fake(code = 0, spawnCwd = () => fs.realpathSync(os.homedir())) {
  const calls: { argv: string[]; cwd: string; env: Record<string, string> }[] = []
  const deps: Deps = {
    spawn: async (argv, { cwd, env }) => {
      calls.push({ argv, cwd, env })
      return code
    },
    spawnCwd,
  }
  return { deps, calls }
}

/** The arguments `installSpawn` passes the install for `command` and `args`, run from `/somewhere`. */
function passed(command: string, args: string[]) {
  return installSpawn(command, args, {}, () => "/somewhere").argv.slice(selfCommand().length + 2)
}

test("installSpawn runs the office install entry in this binary with the setup env and the home dir as cwd", () => {
  const spec = installSpawn(
    "doctor",
    ["--home", "/h"],
    { PATH: "/bin", BUN_OPTIONS: "x", NODE_OPTIONS: "y", LD_PRELOAD: "z", SSH_AUTH_SOCK: "s" },
    () => "/somewhere",
  )
  expect(spec.argv).toEqual([...selfCommand(), "install", "doctor", "--home", "/h"])
  expect(spec.env).toEqual({ PATH: "/bin", SSH_AUTH_SOCK: "s" })
  expect(spec.cwd).toBe(fs.realpathSync(os.homedir()))
})

test("a relative home is made absolute against the callers folder; ~ and empty values pass unchanged", () => {
  expect(passed("start", ["--home", "rel"])).toEqual(["--home", "/somewhere/rel"])
  expect(passed("start", ["--home=rel"])).toEqual(["--home=/somewhere/rel"])
  expect(passed("start", ["--home", "~x"])).toEqual(["--home", "/somewhere/~x"])
  // The install's parser rejects only a separate value that looks like a flag; `-` and `--home=-x` are values.
  expect(passed("start", ["--home=-x"])).toEqual(["--home=/somewhere/-x"])
  expect(passed("start", ["--home", "-"])).toEqual(["--home", "/somewhere/-"])
  for (const args of [["--home", "~/x"], ["--home=~"], ["--home="], ["--home", "-x"], ["--home", "/abs"], ["--home"]])
    expect(passed("start", args)).toEqual(args)
  expect(passed("doctor", ["--home", "a", "--home=b"])).toEqual(["--home", "/somewhere/a", "--home=/somewhere/b"])
  const env = (value: string) => installSpawn("start", [], { OPENCORP_HOME: value }, () => "/somewhere").env
  expect(env("rel")).toEqual({ OPENCORP_HOME: "/somewhere/rel" })
  expect(env("-x")).toEqual({ OPENCORP_HOME: "/somewhere/-x" })
  for (const value of ["~/o", "", "/abs"]) expect(env(value)).toEqual({ OPENCORP_HOME: value })
})

test("a relative local from path is made absolute; urls and scp paths pass unchanged", () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-from-")))
  try {
    fs.mkdirSync(path.join(work, "acme"))
    const from = (command: string, args: string[]) =>
      installSpawn(command, args, {}, () => work).argv.slice(selfCommand().length + 2)
    expect(from("onboard", ["--from", "acme"])).toEqual(["--from", path.join(work, "acme")])
    expect(from("onboard", ["--from=acme"])).toEqual([`--from=${path.join(work, "acme")}`])
    for (const value of ["missing", "https://x/y.git", "git@host:acme.git", "~/acme", "/abs"])
      expect(from("onboard", ["--from", value])).toEqual(["--from", value])
    expect(from("init", ["--from", "acme", "--from=acme"])).toEqual(["--from", "acme", "--from=acme"])
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})

test("the callers folder is read only when a relative value needs it", () => {
  const gone = () => {
    throw Object.assign(new Error("no cwd"), { code: "ENOENT" })
  }
  expect(installSpawn("start", ["--home", "/abs"], {}, gone).argv.slice(-2)).toEqual(["--home", "/abs"])
  expect(installSpawn("start", [], { OPENCORP_HOME: "~/o" }, gone).argv.at(-1)).toBe("start")
  expect(installSpawn("start", ["--home", "rel"], {}, gone).argv.slice(-2)).toEqual(["--home", "rel"])
  expect(installSpawn("start", [], { OPENCORP_HOME: "rel" }, gone).env).toEqual({ OPENCORP_HOME: "rel" })
})

test("a missing home folder is one line and exit 1", async () => {
  const { deps, calls } = fake(0, () => {
    throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
  })
  const err: string[] = []
  const error = console.error
  console.error = (...a: unknown[]) => void err.push(a.join(" "))
  try {
    expect(await install("start", [], deps)).toBe(1)
  } finally {
    console.error = error
  }
  expect(err).toEqual([`opencorp start: your home folder ${os.homedir()} doesn't exist`])
  expect(calls).toEqual([])
})

test("start, restart, doctor and offboard run the install with their flags and return its exit code", async () => {
  const runs = [
    { cmd: "start", run: start, code: 3, flags: ["--home", "/h"] },
    { cmd: "restart", run: restart, code: 1, flags: ["--home", "/h"] },
    { cmd: "doctor", run: doctor, code: 1, flags: ["--home", "/h"] },
    { cmd: "offboard", run: offboard, code: 1, flags: ["--yes", "--delete-company", "--home", "/h"] },
  ]
  for (const { cmd, run, code, flags } of runs) {
    const { deps, calls } = fake(code)
    expect(await run(flags, deps)).toBe(code)
    expect(calls).toHaveLength(1)
    expect(calls[0].argv).toEqual([...selfCommand(), "install", cmd, ...flags])
    expect(calls[0].cwd).toBe(fs.realpathSync(os.homedir()))
    expect(calls[0].env.BUN_OPTIONS).toBeUndefined()
  }
  const { commands } = await import("../src/main")
  expect(commands.restart.summary).toBe("Stop the office and start it again")
})

test("init and offboard are commands with their own summaries", async () => {
  const { commands } = await import("../src/main")
  expect(commands.init.summary).toContain("Create the company")
  expect(commands.offboard.summary).toContain("Remove this office")
  expect((await commands.init.load()).run).toBeFunction()
  expect((await commands.offboard.load()).run).toBeFunction()
})

test("what the CLI passes reaches the programs it runs", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-spawn-")))
  try {
    const argv = ["/bin/sh", "-c", 'test "$X" = set && test "$(pwd -P)" = "$D"']
    expect(await realDeps.spawn(argv, { cwd: dir, env: { X: "set", D: dir, PATH: "/usr/bin:/bin" } })).toBe(0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test(
  "`opencorp start` on a home with no office exits 3 with the setup hint from the TS install",
  async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-start-")))
    try {
      const home = path.join(tmp, "oh")
      fs.mkdirSync(home)
      fs.mkdirSync(path.join(tmp, "h"))
      const result = await runWrapper(["start"], tmp, {
        HOME: path.join(tmp, "h"),
        PATH: "/usr/bin:/bin",
        OPENCORP_BUN: process.execPath,
        OPENCORP_HOME: home,
      })
      expect(result.stderr).toContain(
        `opencorp: no office at ${home} yet; run \`opencorp init\` to create one, or \`opencorp onboard --from URL\` to join one`,
      )
      expect(result.code).toBe(3)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  },
  60_000,
)

test(
  "a relative --home names the folder it was typed in, and setup never reads that folders or HOMEs .env or bunfig.toml",
  async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-rel-")))
    try {
      const work = path.join(tmp, "w")
      const home = path.join(tmp, "h")
      for (const dir of [work, home]) {
        fs.mkdirSync(dir)
        fs.writeFileSync(path.join(dir, "bunfig.toml"), 'preload = ["./p.ts"]\n')
        fs.writeFileSync(
          path.join(dir, "p.ts"),
          `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(path.join(dir, "MARKER"))}, "")\n`,
        )
        fs.writeFileSync(path.join(dir, ".env"), "OPENCORP_HOME=/nonexistent\n")
      }
      const env = { HOME: home, PATH: "/usr/bin:/bin", OPENCORP_BUN: process.execPath }
      const relative = await runWrapper(["start", "--home", "rel"], work, env)
      expect(relative.stderr).toContain(`no office at ${path.join(work, "rel")} yet`)
      expect(relative.code).toBe(3)
      // Without --home or OPENCORP_HOME, a planted .env that loaded would name /nonexistent.
      const plain = await runWrapper(["start"], work, env)
      expect(plain.stderr).toContain(`no office at ${path.join(home, ".opencorp")} yet`)
      expect(plain.stderr).not.toContain("/nonexistent")
      expect(plain.code).toBe(3)
      expect(fs.existsSync(path.join(work, "MARKER"))).toBe(false)
      expect(fs.existsSync(path.join(home, "MARKER"))).toBe(false)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  },
  60_000,
)

test("a running office answers the probe with one request; no socket is no office", async () => {
  // A short path: unix socket paths are limited to about 100 bytes.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aco-"))
  const socket = path.join(home, "office.sock")
  try {
    expect(await officeAnswers(socket)).toBe(false)
    const office = createFakeOffice({ socket })
    try {
      expect(await officeAnswers(socket)).toBe(true)
      expect(office.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /health"])
    } finally {
      office.stop()
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test("`opencorp` with no office says so and exits 3 before loading the TUI", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aco-"))
  process.env.OPENCORP_HOME = home
  const err: string[] = []
  const error = console.error
  console.error = (...a: unknown[]) => void err.push(a.join(" "))
  try {
    expect(await main(["--continue"])).toBe(3)
    expect(err).toEqual(["The office isn't running. Run `opencorp doctor`."])
  } finally {
    console.error = error
    fs.rmSync(home, { recursive: true, force: true })
  }
}, 10_000)

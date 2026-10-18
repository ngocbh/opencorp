import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { doctor } from "../src/commands/doctor"
import { offboard } from "../src/commands/offboard"
import { restart } from "../src/commands/restart"
import { start } from "../src/commands/start"
import { main } from "../src/main"
import { type Deps, REPO, officeAnswers, syncThenInstall, venvPython } from "../src/office"
import { createFakeOffice } from "../../tui/script/stub"

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

/** Deps whose programs all exist and exit `codes[program]` (0 if absent), recording each call. */
function fake(codes: Record<string, number> = {}, missing: string[] = []) {
  const calls: { argv: string[]; cwd?: string }[] = []
  const errors: string[] = []
  const deps: Deps = {
    exists: (p) => !missing.includes(p),
    which: (cmd) => (missing.includes(cmd) ? null : `/bin/${cmd}`),
    spawn: async (argv, cwd) => {
      calls.push({ argv, cwd })
      return codes[path.basename(argv[0])] ?? 0
    },
    error: (m) => void errors.push(m),
  }
  return { deps, calls, errors }
}

test("the repo is this checkout, and its venv's python runs the install", () => {
  expect(fs.existsSync(path.join(REPO, "pyproject.toml"))).toBe(true)
  expect(venvPython()).toBe(path.join(REPO, ".venv", "bin", "python"))
})

test("syncThenInstall syncs the venv, then runs the Python onboarding with the flags it was given", async () => {
  const { deps, calls } = fake({ python: 5 })
  expect(await syncThenInstall("onboard", ["--service", "tmux", "--from", "git@example.com:acme.git"], deps)).toBe(5)
  expect(calls).toEqual([
    { argv: ["/bin/uv", "sync", "--frozen", "--quiet"], cwd: REPO },
    {
      argv: [venvPython(), "-m", "opencorp.install", "onboard", "--service", "tmux", "--from", "git@example.com:acme.git"],
      cwd: undefined,
    },
  ])
})

test("syncThenInstall syncs the venv, then runs the Python init with the flags it was given", async () => {
  const { deps, calls } = fake({ python: 4 })
  expect(await syncThenInstall("init", ["--company", "Acme", "--remote", "git@example.com:acme.git"], deps)).toBe(4)
  expect(calls).toEqual([
    { argv: ["/bin/uv", "sync", "--frozen", "--quiet"], cwd: REPO },
    {
      argv: [venvPython(), "-m", "opencorp.install", "init", "--company", "Acme", "--remote", "git@example.com:acme.git"],
      cwd: undefined,
    },
  ])
})

test("syncThenInstall stops when uv is missing, naming the command", async () => {
  const noUv = fake({}, ["uv", path.join(os.homedir(), ".local", "bin", "uv")])
  expect(await syncThenInstall("init", [], noUv.deps)).toBe(1)
  expect(noUv.calls).toEqual([])
  expect(noUv.errors.join("\n")).toContain("opencorp init: uv not found")
})

test("offboard runs the Python offboarding with its flags and never syncs the venv", async () => {
  const { deps, calls } = fake({ python: 1 })
  expect(await offboard(["--yes", "--delete-company", "--home", "/h"], deps)).toBe(1)
  expect(calls).toEqual([
    { argv: [venvPython(), "-m", "opencorp.install", "offboard", "--yes", "--delete-company", "--home", "/h"], cwd: undefined },
  ])
  const bare = fake({}, [venvPython()])
  expect(await offboard([], bare.deps)).toBe(1)
  expect(bare.calls).toEqual([])
})

test("init and offboard are commands with their own summaries", async () => {
  const { commands } = await import("../src/main")
  expect(commands.init.summary).toContain("Create the company")
  expect(commands.offboard.summary).toContain("Remove this office")
  expect((await commands.init.load()).run).toBeFunction()
  expect((await commands.offboard.load()).run).toBeFunction()
})

test("syncThenInstall finds uv in ~/.local/bin when it isn't on PATH", async () => {
  const { deps, calls } = fake({}, ["uv"])
  expect(await syncThenInstall("onboard", [], deps)).toBe(0)
  expect(calls[0].argv).toEqual([path.join(os.homedir(), ".local", "bin", "uv"), "sync", "--frozen", "--quiet"])
})

test("syncThenInstall stops when uv is missing or the sync fails", async () => {
  const noUv = fake({}, ["uv", path.join(os.homedir(), ".local", "bin", "uv")])
  expect(await syncThenInstall("onboard", [], noUv.deps)).toBe(1)
  expect(noUv.calls).toEqual([])
  expect(noUv.errors.join("\n")).toContain("uv not found")
  const failing = fake({ uv: 2 })
  expect(await syncThenInstall("onboard", [], failing.deps)).toBe(2)
  expect(failing.calls).toHaveLength(1)
})

test("doctor runs the Python checks with its flags, or says to onboard when there is no venv", async () => {
  const { deps, calls } = fake({ python: 1 })
  expect(await doctor(["--home", "/h"], deps)).toBe(1)
  expect(calls).toEqual([{ argv: [venvPython(), "-m", "opencorp.install", "doctor", "--home", "/h"], cwd: undefined }])
  const bare = fake({}, [venvPython()])
  expect(await doctor([], bare.deps)).toBe(1)
  expect(bare.calls).toEqual([])
  expect(bare.errors.join("\n")).toContain("run `opencorp onboard`")
})

test("doctor tells the Python checks which bun runs it, for the commands it prints", async () => {
  delete process.env.OPENCORP_BUN
  let seen: string | undefined
  const { deps } = fake()
  deps.spawn = async () => {
    seen = process.env.OPENCORP_BUN
    return 0
  }
  expect(await doctor([], deps)).toBe(0)
  expect(seen).toBe(process.execPath)
})

test("start runs the Python start with its flags", async () => {
  const { deps, calls } = fake({ python: 3 })
  expect(await start(["--home", "/h"], deps)).toBe(3)
  expect(calls).toEqual([{ argv: [venvPython(), "-m", "opencorp.install", "start", "--home", "/h"], cwd: undefined }])
})

test("restart syncs the venv, then runs the Python restart with its flags", async () => {
  const { deps, calls } = fake({ python: 1 })
  expect(await restart(["--home", "/h"], deps)).toBe(1)
  expect(calls).toEqual([
    { argv: ["/bin/uv", "sync", "--frozen", "--quiet"], cwd: REPO },
    { argv: [venvPython(), "-m", "opencorp.install", "restart", "--home", "/h"], cwd: undefined },
  ])
  const { commands } = await import("../src/main")
  expect(commands.restart.summary).toBe("Stop the office and start it again")
})

// CI's ts job has no venv; the office job tests `start` itself.
test.skipIf(!fs.existsSync(venvPython()))(
  "`opencorp start` on an OPENCORP_HOME with no office exits 3 with the onboarding hint from the real Python",
  async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-home-")))
    try {
      const proc = Bun.spawn([process.execPath, path.join(REPO, "packages", "cli", "src", "main.ts"), "start"], {
        env: { ...process.env, OPENCORP_HOME: home },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      })
      const stderr = await new Response(proc.stderr).text()
      expect(await proc.exited).toBe(3)
      expect(stderr).toContain(`no office at ${home} yet; run \`opencorp init\` to create one, or \`opencorp onboard --from URL\``)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  },
  30_000,
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

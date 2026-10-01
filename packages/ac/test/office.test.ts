import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { doctor } from "../src/commands/doctor"
import { onboard } from "../src/commands/onboard"
import { start } from "../src/commands/start"
import { main } from "../src/main"
import { type Deps, REPO, officeAnswers, venvPython } from "../src/office"
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

test("onboard syncs the venv, then runs the Python onboarding with the flags it was given", async () => {
  const { deps, calls } = fake({ python: 5 })
  expect(await onboard(["--service", "tmux", "--no-hire"], deps)).toBe(5)
  expect(calls).toEqual([
    { argv: ["/bin/uv", "sync", "--frozen"], cwd: REPO },
    { argv: [venvPython(), "-m", "agent_corp.install", "onboard", "--service", "tmux", "--no-hire"], cwd: undefined },
  ])
})

test("onboard finds uv in ~/.local/bin when it isn't on PATH", async () => {
  const { deps, calls } = fake({}, ["uv"])
  expect(await onboard([], deps)).toBe(0)
  expect(calls[0].argv).toEqual([path.join(os.homedir(), ".local", "bin", "uv"), "sync", "--frozen"])
})

test("onboard stops when uv is missing or the sync fails", async () => {
  const noUv = fake({}, ["uv", path.join(os.homedir(), ".local", "bin", "uv")])
  expect(await onboard([], noUv.deps)).toBe(1)
  expect(noUv.calls).toEqual([])
  expect(noUv.errors.join("\n")).toContain("uv not found")
  const failing = fake({ uv: 2 })
  expect(await onboard([], failing.deps)).toBe(2)
  expect(failing.calls).toHaveLength(1)
})

test("doctor runs the Python checks with its flags, or says to onboard when there is no venv", async () => {
  const { deps, calls } = fake({ python: 1 })
  expect(await doctor(["--home", "/h"], deps)).toBe(1)
  expect(calls).toEqual([{ argv: [venvPython(), "-m", "agent_corp.install", "doctor", "--home", "/h"], cwd: undefined }])
  const bare = fake({}, [venvPython()])
  expect(await doctor([], bare.deps)).toBe(1)
  expect(bare.calls).toEqual([])
  expect(bare.errors.join("\n")).toContain("run `ac onboard`")
})

test("start runs the Python start with its flags", async () => {
  const { deps, calls } = fake({ python: 3 })
  expect(await start(["--home", "/h"], deps)).toBe(3)
  expect(calls).toEqual([{ argv: [venvPython(), "-m", "agent_corp.install", "start", "--home", "/h"], cwd: undefined }])
})

// CI's ts job has no venv; the office job tests `start` itself.
test.skipIf(!fs.existsSync(venvPython()))(
  "`ac start` on an AGENT_CORP_HOME with no office exits 3 with the onboarding hint from the real Python",
  async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ac-home-")))
    try {
      const proc = Bun.spawn([process.execPath, path.join(REPO, "packages", "ac", "src", "main.ts"), "start"], {
        env: { ...process.env, AGENT_CORP_HOME: home },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      })
      const stderr = await new Response(proc.stderr).text()
      expect(await proc.exited).toBe(3)
      expect(stderr).toContain(`no office at ${home} yet; run \`ac init\` to create one, or \`ac onboard --from URL\``)
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

test("`ac` with no office says so and exits 3 before loading the TUI", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aco-"))
  process.env.AGENT_CORP_HOME = home
  const err: string[] = []
  const error = console.error
  console.error = (...a: unknown[]) => void err.push(a.join(" "))
  try {
    expect(await main(["--continue"])).toBe(3)
    expect(err).toEqual(["The office isn't running. Run `ac doctor`."])
  } finally {
    console.error = error
    fs.rmSync(home, { recursive: true, force: true })
  }
}, 10_000)

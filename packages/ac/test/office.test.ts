import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { doctor } from "../src/commands/doctor"
import { onboard } from "../src/commands/onboard"
import { type Deps, REPO, venvPython } from "../src/office"

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
    { argv: [venvPython(), "-m", "agent_corp.install", "onboard", "--service", "tmux", "--no-hire"], cwd: REPO },
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
  expect(calls).toEqual([{ argv: [venvPython(), "-m", "agent_corp.install", "doctor", "--home", "/h"], cwd: REPO }])
  const bare = fake({}, [venvPython()])
  expect(await doctor([], bare.deps)).toBe(1)
  expect(bare.calls).toEqual([])
  expect(bare.errors.join("\n")).toContain("run `ac onboard`")
})

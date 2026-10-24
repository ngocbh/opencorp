/** Sandbox test helpers (Python's sandbox conftest fixtures). */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { type Helper, type OfficePaths, SandboxPolicy } from "../../src/sandbox/policy.ts"
import { command, scrubbedEnv } from "../../src/sandbox/run.ts"
import { tempDir } from "../helpers.ts"

/** A fresh `ws` and `tmp` under one temp dir (removed after the test), and `make`, which builds policies over them. */
export function makePolicy(): {
  root: string
  ws: string
  tmp: string
  make(opts?: {
    writable?: boolean
    network?: boolean
    readOnly?: readonly string[]
    helper?: Helper
    office?: OfficePaths
  }): SandboxPolicy
} {
  const root = tempDir()
  const ws = path.join(root, "ws")
  const tmp = path.join(root, "tmp")
  fs.mkdirSync(ws)
  fs.mkdirSync(tmp)
  return {
    root,
    ws,
    tmp,
    make: ({ writable = true, network = false, readOnly = [], helper, office } = {}) =>
      new SandboxPolicy({ workspace: ws, writable, network, tmpdir: tmp, readOnly, helper, office }),
  }
}

/** A policy with exactly these (already real) paths and no disk checks, for golden profiles. */
export function goldenPolicy(fields: {
  workspace: string
  writable: boolean
  network: boolean
  tmpdir: string
  readOnly?: readonly string[]
  install?: readonly string[]
  helper?: Helper
}): SandboxPolicy {
  return Object.assign(Object.create(SandboxPolicy.prototype), {
    workspace: fields.workspace,
    writable: fields.writable,
    network: fields.network,
    tmpdir: fields.tmpdir,
    readOnly: fields.readOnly ?? [],
    helper: fields.helper,
    office: { home: "/Users/me", install: fields.install ?? [], tools: [], path: [] },
  })
}

let available: boolean | undefined

/** Whether a sandboxed `/bin/sh -c "exit 0"` runs here, probed once (sync) at first use; throws when it
 *  can't and `CI` or `OPENCORP_TEST_SANDBOX` is set (Python's fixture fails on CI). */
export function sandboxAvailable(): boolean {
  if (available !== undefined) return available
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-probe-")))
  let problem: string | null
  try {
    const ws = path.join(root, "ws")
    const tmp = path.join(root, "tmp")
    fs.mkdirSync(ws)
    fs.mkdirSync(tmp)
    const policy = new SandboxPolicy({ workspace: ws, writable: false, network: false, tmpdir: tmp })
    // No canary: the probe only asks whether a profile applies at all.
    const [file, ...args] = command(policy, ["/bin/sh", "-c", "exit 0"])
    const result = spawnSync(file!, args, { cwd: ws, env: scrubbedEnv(policy), timeout: 30_000, encoding: "utf8" })
    problem = result.error ? String(result.error) : result.status === 0 ? null : result.stderr.trim()
  } catch (error) {
    problem = String(error)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  if (problem !== null && (process.env.CI || process.env.OPENCORP_TEST_SANDBOX)) {
    throw new Error(`sandbox unavailable on CI: ${problem}`)
  }
  available = problem === null
  return available
}

/** The pids of processes whose command line is `sleep <marker>` (by path or not). */
function sleepers(marker: string): number[] {
  const out = spawnSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" }).stdout
  const pattern = new RegExp(`(^|/)sleep ${marker}$`)
  return out
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m) => m !== null && pattern.test(m[2]!))
    .map((m) => Number(m![1]))
}

/** Whether no process's command line matches `(^|/)sleep <marker>$` within 5 s (`ps -A -o pid=,command=`);
 *  SIGKILLs any that remain (by pid) before answering false, so a failed test leaves no orphan. */
export async function gone(marker: string): Promise<boolean> {
  const deadline = performance.now() + 5_000
  for (;;) {
    const alive = sleepers(marker)
    if (alive.length === 0) return true
    if (performance.now() >= deadline) {
      for (const pid of alive) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
      }
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

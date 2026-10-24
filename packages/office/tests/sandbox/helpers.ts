/** Sandbox test helpers (Python's sandbox conftest fixtures). */
import { type SpawnSyncReturns, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { helperCommand } from "../../src/platform.ts"
import { type Helper, type OfficePaths, SandboxPolicy } from "../../src/sandbox/policy.ts"
import { command, scrubbedEnv } from "../../src/sandbox/run.ts"
import { tempDir } from "../helpers.ts"

const SRC = fileURLToPath(new URL("../../src/sandbox/", import.meta.url))

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

/** Runs `env` in the sandbox (a writable workspace `ws`, no network, tmpdir `tmp`) from a Bun child whose
 *  environment is this process's plus `env`, and returns the child: its stdout is the sandboxed `env`
 *  output. A test sets secrets this way because it never changes its own environment. */
export function envInChild(ws: string, tmp: string, env: Record<string, string>): SpawnSyncReturns<string> {
  const script = path.join(tempDir(), "child.ts")
  fs.writeFileSync(
    script,
    [
      `import { SandboxPolicy } from "${pathToFileURL(path.join(SRC, "policy.ts")).href}"`,
      `import { run } from "${pathToFileURL(path.join(SRC, "run.ts")).href}"`,
      `const policy = new SandboxPolicy({ workspace: ${JSON.stringify(ws)}, writable: true, network: false, tmpdir: ${JSON.stringify(tmp)} })`,
      `process.stdout.write((await run(policy, ["env"], { timeout: 20 })).stdout)`,
      "",
    ].join("\n"),
  )
  return spawnSync(process.execPath, ["--no-install", "--no-env-file", "--config=/dev/null", script], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 30_000,
  })
}

/** Runs one `__fs-helper` request (unsandboxed) in `ws`: stdin is the request as JSON, or `request` itself
 *  when it is a string (for stdin that isn't JSON); env is `PATH`, `HOME` (a fresh temp dir) and `env`.
 *  `reply` is the parsed stdout, or undefined when stdout isn't JSON. */
export function helperOp(
  ws: string,
  request: object | string,
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; reply: unknown } {
  const [file, ...args] = helperCommand().argv
  const result = spawnSync(file, args, {
    cwd: ws,
    // HOME is not `ws`, as in the sandbox (its private tmpdir): Bun's transpiler cache lands under HOME.
    env: { PATH: "/usr/bin:/bin", HOME: tempDir(), ...env },
    input: typeof request === "string" ? request : JSON.stringify(request),
    encoding: "utf8",
    timeout: 20_000,
  })
  if (result.error) throw result.error
  let reply: unknown
  try {
    reply = JSON.parse(result.stdout)
  } catch {
    reply = undefined
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, reply }
}

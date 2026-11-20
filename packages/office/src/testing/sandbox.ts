/** Whether the office's workspace sandbox runs here, for tests in any package that need it to skip where it can't. */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SandboxPolicy } from "../runtime/sandbox/policy.ts"
import { command, scrubbedEnv } from "../runtime/sandbox/run.ts"

let runs: boolean | undefined

/** Whether a sandboxed `/bin/sh -c "exit 0"` runs here, as the workspace's sandbox would run it; probed once. */
export function sandboxRuns(): boolean {
  if (runs !== undefined) return runs
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-probe-")))
  try {
    const ws = path.join(root, "ws")
    const tmp = path.join(root, "tmp")
    fs.mkdirSync(ws)
    fs.mkdirSync(tmp)
    const policy = new SandboxPolicy({ workspace: ws, writable: false, network: false, tmpdir: tmp })
    const [file, ...args] = command(policy, ["/bin/sh", "-c", "exit 0"])
    runs = spawnSync(file!, args, { cwd: ws, env: scrubbedEnv(policy), timeout: 30_000 }).status === 0
  } catch {
    runs = false
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  return runs
}

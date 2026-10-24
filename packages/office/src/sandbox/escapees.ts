/**
 * Find and kill macOS processes that left a sandboxed call's process group.
 *
 * A sandboxed process can `setsid()` into a new session, so killing the call's process
 * group misses it; macOS has no pid namespace to fall back on. It still carries the call's
 * Seatbelt profile, though, and `sandbox_check` can ask any process's profile whether it may
 * write a path. Each call's profile gets a write rule for its own canary directory, so a
 * process that may write that directory, but not a sibling one next to it, runs under
 * this call's profile and nothing else's.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { listAllPids, sandboxCheck } from "../platform.ts"

// Enough rounds to stop a process tree that forks while it is being stopped.
const MAX_ROUNDS = 50

/**
 * Two new directories: `allowed`, which only this call's profile may write, and `denied`.
 *
 * Both must exist, because `sandbox_check` reports a missing path as denied. `denied`
 * tells this call's profile apart from ones that allow writes broadly (several system
 * agents' do), which would allow both.
 */
export class Canary {
  readonly root: string
  readonly allowed: string
  readonly denied: string

  /** `avoid`: directories (real paths) the call may write; the canary is created outside them, since
   *  under one of them `denied` would be writable too. */
  constructor(avoid: readonly string[] = []) {
    const roots = [fs.realpathSync(os.tmpdir()), "/private/tmp", "/private/var/tmp"]
    const inside = (dir: string, parent: string) => dir === parent || dir.startsWith(parent + path.sep)
    const root = roots.find((r) => !avoid.some((a) => inside(r, a))) ?? roots[0]!
    this.root = fs.mkdtempSync(path.join(root, "opencorp-call-"))
    this.allowed = path.join(this.root, "allowed")
    this.denied = path.join(this.root, "denied")
    fs.mkdirSync(this.allowed)
    fs.mkdirSync(this.denied)
  }

  /** Removes the directories. */
  close(): void {
    try {
      fs.rmSync(this.root, { recursive: true, force: true })
    } catch {
      // Errors ignored, as Python's rmtree(ignore_errors=True).
    }
  }
}

/**
 * SIGKILLs every process running under the profile that allows writing `canary.allowed`, and returns
 * the pids that were killed.
 *
 * Matching processes are stopped first, round by round, until a round finds no new
 * ones, so a process can't spawn a survivor between the scan and the kill.
 */
export function killEscaped(canary: Canary): number[] {
  // sandbox_check returns 0 for allowed, 1 for denied (and for an unsandboxed
  // process's "is it sandboxed" query, 0), -1 on error.
  const inCall = (pid: number) =>
    sandboxCheck(pid, null) === 1 &&
    sandboxCheck(pid, "file-write-data", canary.allowed) === 0 &&
    sandboxCheck(pid, "file-write-data", canary.denied) === 1

  const me = process.pid
  const found: number[] = []
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      // Pid 0 is kernel_task, and signalling 0 would hit our own process group.
      const fresh = listAllPids().filter((pid) => pid > 0 && pid !== me && !found.includes(pid) && inCall(pid))
      if (fresh.length === 0) break
      for (const pid of fresh) signal(pid, "SIGSTOP")
      found.push(...fresh)
    }
  } finally {
    // A round that throws must not leave the processes already stopped alive.
    for (const pid of found) signal(pid, "SIGKILL")
  }
  return found
}

/** Sends `sig` to `pid`, ignoring a process that is gone or not ours. */
function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ESRCH" && code !== "EPERM") throw error
  }
}

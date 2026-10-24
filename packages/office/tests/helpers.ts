/** Test helpers shared by the office's tests (Python's conftest fixtures). */
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { onTestFinished } from "bun:test"
import { sameProcess, startTime } from "../src/install/proc.ts"

/** Polls `predicate` every 20 ms until it returns something truthy, and returns that; throws
 *  `timed out waiting for <what>` after `timeout` ms (Python's `wait_for`). */
export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  { timeout = 30_000, what = "condition" } = {},
): Promise<NonNullable<T>> {
  const deadline = performance.now() + timeout
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (performance.now() >= deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Makes a directory with `prefix`, returns its real path, and removes it when the current test finishes. */
function dirForThisTest(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(prefix))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A fresh directory (real path) removed when the current test finishes. Call inside a test. */
export function tempDir(): string {
  return dirForThisTest(path.join(os.tmpdir(), "opencorp-"))
}

/** A directory with a short path, for unix sockets (macOS limits their paths to 104 bytes);
 *  removed when the current test finishes. Call inside a test. */
export function shortDir(): string {
  return dirForThisTest("/tmp/oc-")
}

/** The `ps` binary: /bin/ps on macOS, /usr/bin/ps on some Linux images. */
export const PS = ["/bin/ps", "/usr/bin/ps"].find((p) => fs.existsSync(p))!

/** A process started by a test: `/bin/sh -c script` leading its own group, stdout piped. */
export interface Group {
  child: ChildProcess
  pid: number
  /** Its start time read right after the spawn (null if it had already exited). */
  started: number | null
  /** Resolves with the exit code and signal once it exits. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /** The next line it prints. */
  line(): Promise<string>
  /** Also kills `pid` at test end if it still has `started` (a grandchild the script printed). */
  track(pid: number, started: number | null): void
}

/** Whether the process that started at `started` is gone: no longer running with that start time, or a zombie
 *  (`ps -o stat=` starting with Z; an orphan's reaper may be slow, as in some containers). Reads only. */
export function isGone(pid: number, started: number | null): boolean {
  if (started === null || !sameProcess(pid, started)) return true
  try {
    const stat = execFileSync(PS, ["-o", "stat=", "-p", String(pid)], {
      env: {},
      stdio: ["ignore", "pipe", "ignore"],
    })
    return stat.toString().trim().startsWith("Z")
  } catch {
    return true // ps exits non-zero when there is no such pid
  }
}

/** Starts `/bin/sh -c script` in a new process group (stdin and stderr ignored, stdout piped). When the
 *  current test finishes, kills the group if its leader still has its recorded start time, and each tracked
 *  process that still has its own. Never signals by name or pattern. Call inside a test. */
export function startGroup(script: string): Group {
  const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] })
  const pid = child.pid!
  const started = startTime(pid)
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  )
  const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]()
  const tracked: { pid: number; started: number | null }[] = []
  onTestFinished(() => {
    if (started !== null && sameProcess(pid, started)) {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {}
    }
    for (const t of tracked) {
      if (t.started !== null && sameProcess(t.pid, t.started)) {
        try {
          process.kill(t.pid, "SIGKILL")
        } catch {}
      }
    }
  })
  return {
    child,
    pid,
    started,
    exited,
    async line() {
      const next = await lines.next()
      if (next.done) throw new Error("the process closed its stdout")
      return next.value
    },
    track(pid, started) {
      tracked.push({ pid, started })
    },
  }
}

/** Test helpers shared by the office's tests (Python's conftest fixtures). */
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { onTestFinished, spyOn } from "bun:test"
import { args, sameProcess, startTime } from "../src/install/proc.ts"

/** The lines this process writes to stderr until the test finishes, captured instead of written. */
export function captureStderr(): string[] {
  const lines: string[] = []
  const spy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    lines.push(...String(chunk).split("\n").filter(Boolean))
    return true
  })
  onTestFinished(() => spy.mockRestore())
  return lines
}

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

/**
 * Absolute folders the office can't use though they may exist, each as `[label, cwd, the 422's message]`: a name too
 * long for the system, a real folder deeper than PATH_MAX, and (unless running as root, whom modes don't stop) a
 * folder below one the office can't search. Call `restore` in a `finally`: it gives the locked folder its mode back
 * and removes the deep tree, which the per-test cleanup couldn't. Call inside a test.
 */
export function unusableFolders(): { folders: [string, string, string][]; restore: () => void } {
  const top = tempDir()
  const deep = path.join(top, "deep")
  const level = "d".repeat(250)
  fs.mkdirSync(deep)
  // One level at a time from inside the last, since the whole path is too long to name (~4.5 KB, over PATH_MAX on
  // both macOS and Linux).
  const made = spawnSync("sh", ["-c", 'for i in $(seq 18); do mkdir "$n" && cd "$n" || exit 1; done'], {
    cwd: deep,
    env: { ...process.env, n: level },
  })
  if (made.status !== 0) throw new Error("couldn't make the deep folder")
  const locked = path.join(top, "locked")
  fs.mkdirSync(path.join(locked, "child"), { recursive: true })
  fs.chmodSync(locked, 0o000)
  const folders: [string, string, string][] = [
    ["name too long", path.join(top, "a".repeat(300)), "cwd is too long for this system"],
    ["deeper than PATH_MAX", path.join(deep, ...Array<string>(18).fill(level)), "cwd is too long for this system"],
  ]
  if (process.getuid?.() !== 0)
    folders.push(["unsearchable parent", path.join(locked, "child"), "cwd can't be opened by the office"])
  return {
    folders,
    restore: () => {
      fs.chmodSync(locked, 0o755)
      execFileSync("rm", ["-rf", deep])
    },
  }
}

/** A directory with a short path, for unix sockets (macOS limits their paths to 104 bytes);
 *  removed when the current test finishes. Call inside a test. */
export function shortDir(): string {
  return dirForThisTest("/tmp/oc-")
}

// A group id no real process can have (Linux PID_MAX_LIMIT is 4,194,304; macOS pids stay under 100,000), so
// a call that slipped past a mocked process.kill could never signal anything.
export const NO_GROUP = 2_000_000_000

let psPath: string | undefined

/** The `ps` binary: /bin/ps on macOS, /usr/bin/ps on some Linux images. Looked up on the first call, so only
 *  the tests that need ps fail on an image without it. */
export function ps(): string {
  if (psPath === undefined) {
    psPath = ["/bin/ps", "/usr/bin/ps"].find((p) => fs.existsSync(p))
    if (psPath === undefined) throw new Error("this test needs ps at /bin/ps or /usr/bin/ps")
  }
  return psPath
}

/** `ps -o stat=` of `pid`, or "" when ps exits non-zero (no such pid). Any other failure, such as a spawn
 *  error or a timeout, is rethrown. Reads only. */
export function psStat(pid: number): string {
  try {
    return execFileSync(ps(), ["-o", "stat=", "-p", String(pid)], {
      env: {},
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })
      .toString()
      .trim()
  } catch (error) {
    // A timeout kills ps by a signal, which leaves `status` null, so only a real exit code means no such pid.
    if (typeof (error as { status?: unknown }).status === "number") return ""
    throw error
  }
}

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
  track(other: number, otherStarted: number | null): void
}

/** Whether the process that started at `started` is gone: no longer running with that start time, or a zombie
 *  (`ps -o stat=` starting with Z; an orphan's reaper may be slow, as in some containers). Reads only. */
export function isGone(pid: number, started: number | null): boolean {
  if (started === null || !sameProcess(pid, started)) return true
  const stat = psStat(pid)
  return stat === "" || stat.startsWith("Z")
}

/** Starts `/bin/sh -c script` in a new process group (stdin and stderr ignored, stdout piped). When the
 *  current test finishes, kills the group if its leader still has its recorded start time, and each tracked
 *  process that still has its own. Never signals by name or pattern. Call inside a test. */
export function startGroup(script: string): Group {
  const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] })
  if (child.pid === undefined) {
    // The spawn error is also emitted as an event; a listener keeps it from becoming an uncaught exception.
    child.on("error", () => {})
    throw new Error("startGroup: spawn failed")
  }
  const pid = child.pid
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
    track(other, otherStarted) {
      tracked.push({ pid: other, started: otherStarted })
    },
  }
}

/** The env `pid` was started with (or re-exec'd into), as written: Linux the bytes of `/proc/<pid>/environ`
 *  (entries split by NUL); macOS the line `ps -E -ww` prints, the command then the entries. */
export function envText(pid: number): string {
  if (process.platform === "linux") return fs.readFileSync(`/proc/${pid}/environ`, "utf8")
  return psCommand(pid, ["-E"])
}

/** The entries of the env `pid` was started with (or re-exec'd into), as name and value: Linux
 *  `/proc/<pid>/environ`; macOS what `ps -E` prints after the command, split before each ` NAME=`. On macOS a
 *  value holding ` NAME=` splits wrongly, so leak scans search `envText` instead. */
export function envEntries(pid: number): [string, string][] {
  let entries: string[]
  if (process.platform === "linux") {
    entries = envText(pid).split("\0")
  } else {
    const command = psCommand(pid, [])
    const withEnv = envText(pid)
    if (!withEnv.startsWith(command)) throw new Error(`ps -E of ${pid} doesn't start with its command`)
    entries = withEnv.slice(command.length).split(/(?:^| )(?=[A-Za-z_][A-Za-z0-9_]*=)/)
  }
  return entries
    .filter((entry) => entry.includes("="))
    .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)])
}

/** The names in the env `pid` was started with (or re-exec'd into), as `envEntries` reads them. */
export function envNames(pid: number): string[] {
  return envEntries(pid).map(([name]) => name)
}

/** What `ps -ww -o command=` with `flags` prints for `pid`, trailing space trimmed. */
function psCommand(pid: number, flags: string[]): string {
  return execFileSync(ps(), [...flags, "-ww", "-o", "command=", "-p", String(pid)], {
    env: { LC_ALL: "C.UTF-8" },
    encoding: "utf8",
    timeout: 5000,
  }).trimEnd()
}

/** The cwd of `pid`: Linux `/proc/<pid>/cwd`; macOS lsof's `n` line. */
export function cwdOf(pid: number): string {
  if (process.platform === "linux") return fs.readlinkSync(`/proc/${pid}/cwd`)
  const out = execFileSync("/usr/sbin/lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], {
    env: { LC_ALL: "C.UTF-8" },
    encoding: "utf8",
    timeout: 10_000,
  })
  const line = out.split("\n").find((l) => l.startsWith("n"))
  if (line === undefined) throw new Error(`lsof shows no cwd for ${pid}`)
  return line.slice(1)
}

/** How many times `--reexeced` is an argument of `pid`. */
export function reexecMarks(pid: number): number {
  const line = args(pid, ps())
  if (line === null) throw new Error(`can't read the arguments of ${pid}`)
  return line.split(" ").filter((arg) => arg === "--reexeced").length
}

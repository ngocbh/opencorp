/** Run one command in the sandbox, in its own process group. */
import { spawn, type StdioOptions } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import type { Readable } from "node:stream"
import * as bwrap from "./bwrap.ts"
import { Canary, killEscaped } from "./escapees.ts"
import { endPipe, helperCommand, pipe, pipeReadable, processLimits, type ProcessLimits } from "../platform.ts"
import { type Helper, helperFiles, isInside, type SandboxPolicy } from "./policy.ts"
import { profile } from "./seatbelt.ts"

export const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"
const READER_GRACE_MS = 2_000
// Timers hold a signed 32-bit millisecond count; anything longer fires at once.
const MAX_TIMEOUT_S = 2_147_483

/** This platform has no supported sandbox. */
export class SandboxUnavailable extends Error {
  override name = "SandboxUnavailable"
}

/** The helper's argv and files for a call; throws `SandboxUnavailable` if a helper file lies inside
 *  the office home (its profile would expose part of the home). */
export function fsHelper(officeHome: string): { argv: string[]; helper: Helper } {
  const { argv, helper } = helperCommand()
  for (const file of helperFiles(helper)) {
    if (isInside(file, officeHome)) {
      throw new SandboxUnavailable(`the file helper ${file} lies inside the office home ${officeHome}`)
    }
  }
  return { argv, helper }
}

/** The outcome of one sandboxed call. */
export interface Result {
  /** The exit status (negative for a signal), or `null` when the call was killed for its timeout or by
   *  `signal`. */
  exit: number | null
  stdout: Buffer
  stderr: Buffer
  timedOut: boolean
  interrupted: boolean
  truncated: boolean
  /** Seconds from the start of `run` to the end of the call. */
  duration: number
  /** Whether the sandbox runner itself refused the call (see `refusal`); the call's own stderr can
   *  spoof it, so it is a hint for the model and the logs, never a basis for policy. */
  refused: boolean
}

/** Returns the whole environment of a sandboxed call; nothing is inherited; the checkout helper also turns
 *  off Bun's transpiler cache. */
export function scrubbedEnv(policy: SandboxPolicy): Record<string, string> {
  const env: Record<string, string> = {
    PATH: SAFE_PATH,
    HOME: policy.tmpdir,
    TMPDIR: policy.tmpdir,
    LANG: "en_US.UTF-8",
    TERM: "dumb",
    // The host's /etc/gitconfig is unreadable in the sandbox, and git treats that as fatal.
    GIT_CONFIG_NOSYSTEM: "1",
  }
  // Bun would cache the helper's transpiled code under HOME, which sandboxed calls can write.
  if (policy.helper !== undefined && "entry" in policy.helper) env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0"
  return env
}

// Sets RLIMIT_NPROC to $1, then execs the rest of its argv. The cap comes in as $1, never in the script text.
// The soft limit goes down first so the hard one is never below it, and the hard one is what makes the cap stick:
// an unprivileged process can raise its soft limit back up to the hard one. `-S`/`-H` are explicit because a bare
// `ulimit -u` sets only the soft limit in zsh; dash (Linux's usual /bin/sh) spells the flag `-p`. A failed cap
// still runs the call (`;`): Seatbelt or bwrap applies either way, and its stderr stays out of the call's output.
const NPROC_SCRIPT =
  'n=$1; shift; { ulimit -S -u "$n" && ulimit -H -u "$n"; } 2>/dev/null || ' +
  '{ ulimit -S -p "$n" && ulimit -H -p "$n"; } 2>/dev/null; exec "$@"'

/** The process cap for a call under an office with `limits` on `platform`: the office's effective per-user limit
 *  (macOS: the smaller of the soft RLIMIT_NPROC and `kern.maxprocperuid`; Linux: the soft RLIMIT_NPROC) less an
 *  eighth, or null (no cap) when that limit is unlimited, the cap would be below 1, or on another platform.
 *  RLIMIT_NPROC counts every process of the user (on Linux, threads too), not just the call's, so the cap is
 *  headroom: the calls together can never take the last eighth of the slots from the office. */
export function processCap(limits: ProcessLimits, platform: string = process.platform): number | null {
  let limit: number | null = null
  if (platform === "darwin") {
    const known = [limits.soft, limits.perUser].filter((value) => value !== null)
    if (known.length > 0) limit = Math.min(...known)
  } else if (platform.startsWith("linux")) {
    limit = limits.soft
  }
  if (limit === null) return null
  const cap = limit - Math.ceil(limit / 8)
  return cap >= 1 ? cap : null
}

let officeCap: number | null | undefined

/** `processCap` of the office's own limits, read once (the office never changes them); null (no cap) when they
 *  can't be read. */
function callCap(): number | null {
  if (officeCap === undefined) {
    try {
      officeCap = processCap(processLimits())
    } catch {
      officeCap = null
    }
  }
  return officeCap
}

/** Returns the host argv that runs `argv` under `policy` on `platform`.
 *
 *  `canary` marks the call's processes on macOS (see `escapees.ts`). `nproc` caps the call's soft and hard
 *  RLIMIT_NPROC (default: the office's cap, see `processCap`; null: no cap) through a `/bin/sh` that then
 *  execs the runner, so the pid, the process group and bwrap's `--die-with-parent` stay the same. Throws
 *  `SandboxUnavailable` when the platform is neither macOS nor Linux, and a `RangeError` when `nproc` is not a
 *  positive safe integer. */
export function command(
  policy: SandboxPolicy,
  argv: readonly string[],
  canary?: string,
  platform: string = process.platform,
  nproc?: number | null,
): string[] {
  let runner: string[]
  if (platform === "darwin") runner = ["/usr/bin/sandbox-exec", "-p", profile(policy, { canary }), ...argv]
  else if (platform.startsWith("linux")) runner = bwrap.command(policy, argv)
  else throw new SandboxUnavailable(`no sandbox for platform ${JSON.stringify(platform)}`)
  const n = nproc === undefined ? callCap() : nproc
  if (n === null) return runner
  if (!(Number.isSafeInteger(n) && n >= 1)) throw new RangeError(`nproc must be a positive integer, got ${n}`)
  return ["/bin/sh", "-c", NPROC_SCRIPT, "sh", String(n), ...runner]
}

/** Whether the sandbox runner refused the call: it exited non-zero and a stderr line holds the
 *  platform's runner signature (`sandbox-exec: ` on macOS, `bwrap: ` on Linux). The call's own stderr
 *  can print the signature too, so this is a hint for the model and the logs: never decide policy on it. */
export function refusal(platform: string, exit: number | null, stderr: Buffer): boolean {
  if (exit === null || exit === 0) return false
  const signature = platform === "darwin" ? "sandbox-exec: " : platform.startsWith("linux") ? "bwrap: " : null
  // The signature holds no newline, so finding it in the whole output finds it in one line.
  return signature !== null && stderr.includes(signature)
}

export interface RunOptions {
  stdin?: string | Buffer
  /** Seconds, more than 0 and at most 2_147_483 (about 24.8 days); default 120. */
  timeout?: number
  signal?: AbortSignal
  /** Bytes kept per stream; default 1 MiB. */
  maxOutput?: number
  /** Called right after spawn with the leader's pid (the group id); the cleanup it returns runs after
   *  the group kill and the sweep, on every path. A `track` that throws still has the call killed and
   *  swept, and `run` then rejects with its error. */
  track?: (pid: number) => () => void
}

/**
 * Runs `argv` in the sandbox, in the workspace, with a scrubbed environment.
 *
 * The call runs in a new process group. The group is killed when the call's first
 * process exits (so nothing it started in the background survives), when `timeout`
 * seconds pass, or when `signal` aborts. On macOS, processes that left the group with
 * `setsid` are then found and killed too; on Linux the pid namespace dies with the call.
 * Each output stream keeps at most `maxOutput` bytes. Rejects with the spawn error when
 * the call can't start, `SandboxUnavailable` on an unsupported platform, a `RangeError`
 * for a `timeout` out of range (before anything starts), and the error of a `track` that
 * throws, after the call is killed and swept.
 */
export async function run(policy: SandboxPolicy, argv: readonly string[], options: RunOptions = {}): Promise<Result> {
  const { stdin, timeout = 120, signal, maxOutput = 1 << 20, track } = options
  if (!(timeout > 0 && timeout <= MAX_TIMEOUT_S)) {
    throw new RangeError(`timeout must be more than 0 and at most ${MAX_TIMEOUT_S} seconds, got ${timeout}`)
  }
  const start = performance.now()
  let canary: Canary | undefined
  try {
    if (process.platform === "darwin") {
      canary = new Canary([policy.tmpdir, ...(policy.writable ? [policy.workspace] : [])])
    }
    const [file, ...args] = command(policy, argv, canary?.allowed)
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined
    let reason: "exit" | "timeout" | "abort" | undefined
    let wake!: () => void
    const woken = new Promise<void>((resolve) => (wake = resolve))
    const settle = (why: "exit" | "timeout" | "abort") => {
      reason ??= why
      wake()
    }
    const own = process.platform === "linux" ? ownPipes(stdin !== undefined) : undefined
    // The stdin write end, closed here until it is handed to `endPipe`, which closes it.
    let stdinFd = own?.stdin
    const closeStdin = () => {
      if (stdinFd !== undefined) fs.closeSync(stdinFd)
      stdinFd = undefined
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file!, args, {
        cwd: policy.workspace,
        env: scrubbedEnv(policy),
        detached: true,
        stdio: own?.stdio ?? [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      })
    } catch (error) {
      own?.stdout.destroy()
      own?.stderr.destroy()
      closeStdin()
      own?.closeChildEnds()
      throw error
    }
    const outPipe = own?.stdout ?? child.stdout!
    const errPipe = own?.stderr ?? child.stderr!
    const input = own ? undefined : child.stdin
    // EPIPE when the call exits without reading its input.
    input?.on("error", () => {})
    const exit = new Promise<void>((resolve) =>
      child.once("exit", (code, sig) => {
        exited = { code, signal: sig }
        settle("exit")
        resolve()
      }),
    )
    const failed = new Promise<Error>((resolve) => child.on("error", resolve))
    const pid = child.pid
    if (pid === undefined) {
      // A spawn that fails emits only `error`, never `exit`.
      outPipe.destroy()
      errPipe.destroy()
      input?.destroy()
      closeStdin()
      own?.closeChildEnds()
      throw await failed
    }
    const out = capture(outPipe, maxOutput)
    const err = capture(errPipe, maxOutput)
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => settle("abort")
    let untrack: (() => void) | undefined
    try {
      try {
        // Inside the kill path, so a close that throws still has the call killed and its streams destroyed.
        own?.closeChildEnds()
        if (stdinFd !== undefined) {
          const fd = stdinFd
          stdinFd = undefined
          // EPIPE when the call exits without reading its input.
          endPipe(fd, stdin!).catch(() => {})
        } else {
          input?.end(stdin)
        }
        untrack = track?.(pid)
        if (signal?.aborted) settle("abort")
        timer = setTimeout(() => settle("timeout"), timeout * 1000)
        signal?.addEventListener("abort", onAbort)
        await woken
      } finally {
        try {
          // On a natural exit the runtime has already reaped the leader, so in theory its pid (the
          // group id) could be reused before this kill. On timeout, cancel or error the leader is
          // normally still running, so the kill can't reach an unrelated group; where the runtime
          // reaps on its own thread, a leader that exits by itself just as the timeout fires is
          // already reaped, the same window as a natural exit.
          killGroup(pid)
          if (canary) killEscaped(canary)
        } finally {
          clearTimeout(timer)
          signal?.removeEventListener("abort", onAbort)
          try {
            untrack?.()
          } finally {
            await exit
          }
        }
      }
    } catch (error) {
      outPipe.destroy()
      errPipe.destroy()
      input?.destroy()
      closeStdin()
      throw error
    }
    // Every writer should be dead now, but an escapee that wasn't found could still hold
    // the pipes; don't wait on it for long.
    let grace: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.all([out.closed, err.closed]),
      new Promise((resolve) => (grace = setTimeout(resolve, READER_GRACE_MS))),
    ])
    clearTimeout(grace)
    outPipe.destroy()
    errPipe.destroy()
    input?.destroy()
    const stopped = reason === "timeout" || reason === "abort"
    const status = stopped ? null : (exited!.code ?? -os.constants.signals[exited!.signal!])
    const stderr = Buffer.concat(err.chunks)
    return {
      exit: status,
      stdout: Buffer.concat(out.chunks),
      stderr,
      timedOut: reason === "timeout",
      interrupted: reason === "abort",
      truncated: out.truncated || err.truncated,
      duration: (performance.now() - start) / 1000,
      refused: refusal(process.platform, status, stderr),
    }
  } finally {
    canary?.close()
  }
}

/** Real pipes for a call's stdio, for Linux, where the runtime's "pipe" is a socketpair and opening /dev/stdout,
 *  /dev/stderr or /dev/fd/N on a socket fails (ENXIO), unlike Python's pipes. `stdio` holds the child's ends,
 *  which `closeChildEnds()` closes here once the child holds its copies; each output stream closes its own fd,
 *  and `stdin` is the input's write end, for the caller to close. */
function ownPipes(withStdin: boolean) {
  let out: [number, number] | undefined
  let err: [number, number] | undefined
  let input: [number, number] | undefined
  try {
    out = pipe()
    err = pipe()
    if (withStdin) input = pipe()
  } catch (error) {
    for (const fd of [...(out ?? []), ...(err ?? [])]) fs.closeSync(fd)
    throw error
  }
  const childEnds = [out[1], err[1], ...(input ? [input[0]] : [])]
  // The runtime's pipe streams poll on the event loop; node:fs streams would hold an fs pool thread (one per
  // core) per pending read or write on a blocking pipe, so a few quiet calls would stall every other call's
  // output and every fs call in the office.
  return {
    stdio: [input ? input[0] : "ignore", out[1], err[1]] as StdioOptions,
    stdin: input?.[1],
    stdout: pipeReadable(out[0]),
    stderr: pipeReadable(err[0]),
    /** Closes every child end, then throws the first error: a runtime that closed one itself shows as EBADF. */
    closeChildEnds: () => {
      let first: unknown
      for (const fd of childEnds) {
        try {
          fs.closeSync(fd)
        } catch (error) {
          first ??= error
        }
      }
      if (first !== undefined) throw first
    },
  }
}

/** SIGKILLs process group `pgid`, ignoring a group that is gone or not ours. */
function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ESRCH" && code !== "EPERM") throw error
  }
}

/** Reads `stream` to its end, keeping at most `limit` bytes; past the cap it reads and discards, so a
 *  writer never blocks. */
function capture(stream: Readable, limit: number) {
  const state = {
    chunks: [] as Buffer[],
    size: 0,
    truncated: false,
    closed: new Promise<void>((resolve) => stream.once("close", () => resolve())),
  }
  // A read error ends the capture; it must not crash the office.
  stream.on("error", () => {})
  stream.on("data", (chunk: Buffer) => {
    const room = limit - state.size
    if (chunk.length > room) state.truncated = true
    if (room > 0) {
      const kept = chunk.subarray(0, room)
      state.chunks.push(kept)
      state.size += kept.length
    }
  })
  return state
}

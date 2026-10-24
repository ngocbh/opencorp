/** Run one command in the sandbox, in its own process group. */
import { spawn } from "node:child_process"
import os from "node:os"
import type { Readable } from "node:stream"
import * as bwrap from "./bwrap.ts"
import { Canary, killEscaped } from "./escapees.ts"
import { helperCommand } from "../platform.ts"
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
 *  the office home (design §2.5: its profile would expose part of the home). */
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

/** Returns the whole environment of a sandboxed call; nothing is inherited. */
export function scrubbedEnv(policy: SandboxPolicy): Record<string, string> {
  return {
    PATH: SAFE_PATH,
    HOME: policy.tmpdir,
    TMPDIR: policy.tmpdir,
    LANG: "en_US.UTF-8",
    TERM: "dumb",
    // The host's /etc/gitconfig is unreadable in the sandbox, and git treats that as fatal.
    GIT_CONFIG_NOSYSTEM: "1",
  }
}

/** Returns the host argv that runs `argv` under `policy` on `platform`.
 *
 *  `canary` marks the call's processes on macOS (see `escapees.ts`). Throws `SandboxUnavailable` when
 *  the platform is neither macOS nor Linux. */
export function command(
  policy: SandboxPolicy,
  argv: readonly string[],
  canary?: string,
  platform: string = process.platform,
): string[] {
  if (platform === "darwin") return ["/usr/bin/sandbox-exec", "-p", profile(policy, { canary }), ...argv]
  if (platform.startsWith("linux")) return bwrap.command(policy, argv)
  throw new SandboxUnavailable(`no sandbox for platform ${JSON.stringify(platform)}`)
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
    const child = spawn(file!, args, {
      cwd: policy.workspace,
      env: scrubbedEnv(policy),
      detached: true,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    })
    const outPipe = child.stdout!
    const errPipe = child.stderr!
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
      throw await failed
    }
    const out = capture(outPipe, maxOutput)
    const err = capture(errPipe, maxOutput)
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => settle("abort")
    let untrack: (() => void) | undefined
    try {
      try {
        if (child.stdin) {
          // The call may exit without reading its input.
          child.stdin.on("error", () => {})
          child.stdin.end(stdin)
        }
        untrack = track?.(pid)
        if (signal?.aborted) settle("abort")
        timer = setTimeout(() => settle("timeout"), timeout * 1000)
        signal?.addEventListener("abort", onAbort)
        await woken
      } finally {
        try {
          // On a natural exit the runtime has already reaped the leader, so in theory its pid (the
          // group id) could be reused before this kill; on timeout, cancel or error the leader isn't
          // reaped yet, so the kill can't reach an unrelated group.
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

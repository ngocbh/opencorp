/** Running the office without a service manager: in a detached tmux session, or as a detached process. */
import type { ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { makeOfficeDir } from "../daemon/sockets.ts"
import { strerror } from "../sandbox/fs_helper.ts"
import { type Completed, type Host, type Launch, ServiceError, daemonEnv, which } from "./launch.ts"
import { args, startTime, stopProcess as stopPid } from "./proc.ts"
import { resolveTools } from "./tools.ts"

/** The office's tmux session, `opencorp-<name>`. */
export function session(launch: Launch): string {
  return `opencorp-${launch.name}`
}

/**
 * The office's own tmux server, `opencorp-<first 8 hex of sha256(home)>`, so the owner's servers are never
 * touched and two offices never share one.
 */
export function socket(launch: Launch): string {
  return `opencorp-${createHash("sha256").update(launch.home, "utf8").digest("hex").slice(0, 8)}`
}

/**
 * Runs `tmux <args>` on the office's own server, in the daemon's env, so a server it starts never holds setup's
 * shell env. `TMUX_TMPDIR` isn't in that env, so every call finds the same socket.
 *
 * `service` checks for tmux with `host.which`, on setup's `PATH`, while this call resolves `tmux` on the daemon's;
 * when they differ, tmux exits 127 and `auto` falls back to the background with a note.
 */
function tmux(launch: Launch, host: Host, ...args: string[]): Promise<Completed> {
  return host.run(["tmux", "-L", socket(launch), ...args], { env: { ...launch.env } })
}

/** `word` for a POSIX shell, as Python's `shlex.quote` writes it: unchanged when it holds only safe characters,
 *  else single-quoted with each `'` as `'"'"'`. */
export function shQuote(word: string): string {
  if (word === "") return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word
  return `'${word.split("'").join(`'"'"'`)}'`
}

/**
 * The daemon for tmux's shell: `env -i` (by absolute path) so tmux's own environment (and any key in it) is
 * dropped, with a soft limit of 4096 open files.
 *
 * Its output goes to the log; its stdin stays on the pane.
 */
export function shellCommand(launch: Launch): string {
  const env = Object.keys(launch.env)
    .sort()
    .map((key) => shQuote(`${key}=${launch.env[key]}`))
  const argv = launch.argv.map(shQuote)
  // stdin holds the pane's pty open: tmux 2.7 closes a pane once nothing has its pty open, even
  // while its process runs, and the kernel then hangs up the daemon. The daemon never reads stdin,
  // and every child it starts gets its own. `-S` sets only the soft limit, as Python's daemon did: no hard cap.
  // `;`, not `&&`: when the hard limit is below 4096 `ulimit` fails, says why in the log, and the daemon still
  // starts.
  return `ulimit -Sn 4096; exec /usr/bin/env -i ${[...env, ...argv].join(" ")} >>${shQuote(launch.log)} 2>&1`
}

/**
 * Starts the daemon in a detached tmux session unless the session is already there.
 *
 * The shell `exec`s the daemon, so the session lives exactly as long as the daemon does.
 */
export async function startTmux(launch: Launch, host: Host): Promise<void> {
  const name = session(launch)
  if ((await tmux(launch, host, "has-session", "-t", `=${name}`)).code === 0) return
  const done = await tmux(launch, host, "new-session", "-d", "-s", name, "-c", launch.cwd, shellCommand(launch))
  if (done.code !== 0) throw new ServiceError(`tmux new-session failed: ${done.stderr.trim()}`)
}

/** `error`'s text: the system's words for an OS error, else its message. */
function messageOf(error: unknown): string {
  return strerror(error) ?? (error instanceof Error ? error.message : String(error))
}

/** How a background daemon ended: its exit code or signal, or `error` when it couldn't be started. */
export interface Exit {
  code: number | null
  signal: NodeJS.Signals | null
  error?: true
}

/** A daemon `startBackground` started: its pid, its exit, and the log's size just before it started. */
export interface BackgroundChild {
  pid: number
  exited: Promise<Exit>
  logFrom: number
}

/**
 * Starts the daemon as a detached process leading its own session, its output appended to the log, with a soft
 * limit of 4096 open files.
 *
 * Returns the daemon's pid, a promise of its exit and the log's size before the spawn, so a wait can stop when the
 * daemon exits and read only what it wrote. The daemon is unref'd: nothing here keeps the caller alive for it.
 *
 * Throws `OfficeStartError` for an office dir that isn't ours, and `ServiceError` if the office program isn't an
 * executable file, the log can't be opened or isn't a regular file, or the daemon can't be started.
 */
export function startBackground(launch: Launch, host: Host): BackgroundChild {
  makeOfficeDir(launch.office)
  const program = launch.argv[0]
  // `sh` would report a missing program only in the log, after the caller has started waiting. The office
  // program is always an absolute path (`launch` builds it from `selfCommand()`), so no search path is given.
  if (which(program, undefined) === null) throw new ServiceError(`can't start ${program}: not an executable file`)
  let log: number
  try {
    // Non-blocking so a FIFO at the log's path can't hang the open; it has no effect on a regular file's writes.
    log = fs.openSync(
      launch.log,
      fs.constants.O_WRONLY |
        fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        fs.constants.O_NOFOLLOW |
        fs.constants.O_NONBLOCK,
      0o600,
    )
  } catch (error) {
    throw new ServiceError(`can't open the office log ${launch.log}: ${messageOf(error)}`)
  }
  try {
    let logFrom: number
    try {
      const stat = fs.fstatSync(log)
      if (!stat.isFile()) throw new ServiceError(`the office log ${launch.log} isn't a regular file`)
      logFrom = stat.size
    } catch (error) {
      if (error instanceof ServiceError) throw error
      throw new ServiceError(`can't open the office log ${launch.log}: ${messageOf(error)}`)
    }
    let child: ChildProcess
    try {
      // `-S` sets only the soft limit, as Python's daemon did: no hard cap. `;`, not `&&`: when the hard limit is
      // below 4096 `ulimit` fails, says why in the log, and the daemon still starts.
      child = host.spawn(["/bin/sh", "-c", 'ulimit -Sn 4096; exec "$@"', "sh", ...launch.argv], {
        cwd: launch.cwd,
        env: { ...launch.env },
        stdio: ["ignore", log, log],
        detached: true,
      })
    } catch (error) {
      throw new ServiceError(`can't start ${program}: ${messageOf(error)}`)
    }
    const { promise: exited, resolve } = Promise.withResolvers<Exit>()
    // Listening also keeps a late spawn error from becoming an uncaught exception.
    child.once("error", () => resolve({ code: null, signal: null, error: true }))
    child.once("exit", (code, signal) => resolve({ code, signal }))
    if (child.pid === undefined) throw new ServiceError(`can't start ${program}`)
    child.unref()
    return { pid: child.pid, exited, logFrom }
  } finally {
    fs.closeSync(log)
  }
}

/** Kills the office's tmux session; says what was done, or null if there was no session. */
export async function stopTmux(launch: Launch, host: Host): Promise<string | null> {
  const name = session(launch)
  if ((await tmux(launch, host, "has-session", "-t", `=${name}`)).code !== 0) return null
  await tmux(launch, host, "kill-session", "-t", `=${name}`)
  return `tmux: killed the session ${name}`
}

/** The pid in the office's pidfile (a regular file, not a symlink, holding a decimal pid), or null. */
export function pidOf(launch: Launch): number | null {
  let fd: number
  try {
    fd = fs.openSync(
      path.join(launch.office, "office.pid"),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    )
  } catch {
    return null
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return null
    const text = fs.readFileSync(fd, "utf8").trim()
    return /^\d+$/.test(text) ? Number(text) : null
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * The process in the office's pidfile, if it is this office's daemon: its args end with `daemon --home <home>`,
 * optionally followed by `--reexeced`. Null when there is none, or it can't be inspected (no `ps`, a read fails).
 *
 * The start time is read before the args, so a pid reused in between fails `stopPid`'s re-check. The program is
 * left out of the match, since it may show up as the binary it links to.
 */
export function daemon(launch: Launch, ps: string | undefined): { pid: number; started: number } | null {
  const pid = pidOf(launch)
  if (pid === null || ps === undefined) return null
  const started = startTime(pid)
  if (started === null) return null
  const line = args(pid, ps)
  if (line === null) return null
  const tail = ` daemon --home ${launch.home}`
  return line.endsWith(tail) || line.endsWith(`${tail} --reexeced`) ? { pid, started } : null
}

/** How long a stop waits after SIGTERM before SIGKILL: the daemon's worst-case stop is about 20 s, and its store
 *  must close cleanly. */
export const STOP_TIMEOUT_MS = 25_000

/** Stops the office's daemon with SIGTERM, then SIGKILL after `timeoutMs`; says what was done, or null if none
 *  runs. Nothing is signalled unless the pid's start time and args are this office's daemon's. */
export async function stopProcess(
  launch: Launch,
  {
    timeoutMs = STOP_TIMEOUT_MS,
    ps = resolveTools(daemonEnv(process.env)).ps,
  }: { timeoutMs?: number; ps?: string } = {},
): Promise<string | null> {
  const found = daemon(launch, ps)
  if (found === null) return null
  if (!(await stopPid(found.pid, found.started, { timeout: timeoutMs }))) return null
  return `stopped the office (pid ${found.pid})`
}

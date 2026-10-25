/** Running the office without a service manager: in a detached tmux session, or as a detached process. */
import type { ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { makeOfficeDir } from "../daemon/sockets.ts"
import { strerror } from "../sandbox/fs_helper.ts"
import { type Host, type Launch, ServiceError, daemonEnv, which } from "./launch.ts"
import { args, startTime, stopProcess as stopPid } from "./proc.ts"
import { resolveTools } from "./tools.ts"

/** The office's tmux session, `opencorp-<name>`. */
export function session(launch: Launch): string {
  return `opencorp-${launch.name}`
}

/** `word` for a POSIX shell, as Python's `shlex.quote` writes it: unchanged when it holds only safe characters,
 *  else single-quoted with each `'` as `'"'"'`. */
function shQuote(word: string): string {
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
  // and every child it starts gets its own. `-S` sets only the soft limit, as Python did: no hard cap. `;`, not
  // `&&`: when the hard limit is below 4096 `ulimit` fails, says why in the log, and the daemon still starts.
  return `ulimit -Sn 4096; exec /usr/bin/env -i ${[...env, ...argv].join(" ")} >>${shQuote(launch.log)} 2>&1`
}

/**
 * Starts the daemon in a detached tmux session unless the session is already there.
 *
 * The shell `exec`s the daemon, so the session lives exactly as long as the daemon does.
 */
export async function startTmux(launch: Launch, host: Host): Promise<void> {
  const name = session(launch)
  if ((await host.run(["tmux", "has-session", "-t", `=${name}`])).code === 0) return
  const done = await host.run(["tmux", "new-session", "-d", "-s", name, "-c", launch.cwd, shellCommand(launch)])
  if (done.code !== 0) throw new ServiceError(`tmux new-session failed: ${done.stderr.trim()}`)
}

/** `error`'s text: the system's words for an OS error, else its message. */
function messageOf(error: unknown): string {
  return strerror(error) ?? (error instanceof Error ? error.message : String(error))
}

/**
 * Starts the daemon as a detached process leading its own session, its output appended to the log, with a soft
 * limit of 4096 open files.
 *
 * Throws `OfficeStartError` for an office dir that isn't ours, and `ServiceError` if the office program isn't an
 * executable file, the log can't be opened, or the daemon can't be started.
 */
export function startBackground(launch: Launch, host: Host): void {
  makeOfficeDir(launch.office)
  const program = launch.argv[0]
  // `sh` would report a missing program only in the log, after the caller has started waiting. The office
  // program is always an absolute path (`launch` builds it from `selfCommand()`), so no search path is given.
  if (which(program, undefined) === null) throw new ServiceError(`can't start ${program}: not an executable file`)
  let log: number
  try {
    log = fs.openSync(
      launch.log,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
      0o600,
    )
  } catch (error) {
    throw new ServiceError(`can't open the office log ${launch.log}: ${messageOf(error)}`)
  }
  try {
    let child: ChildProcess
    try {
      // `-S` sets only the soft limit, as Python did: no hard cap. `;`, not `&&`: when the hard limit is below
      // 4096 `ulimit` fails, says why in the log, and the daemon still starts.
      child = host.spawn(["/bin/sh", "-c", 'ulimit -Sn 4096; exec "$@"', "sh", ...launch.argv], {
        cwd: launch.cwd,
        env: { ...launch.env },
        stdio: ["ignore", log, log],
        detached: true,
      })
    } catch (error) {
      throw new ServiceError(`can't start ${program}: ${messageOf(error)}`)
    }
    // A late spawn error must not become an uncaught exception; the caller's wait reports a daemon that never
    // answers.
    child.on("error", () => {})
    if (child.pid === undefined) throw new ServiceError(`can't start ${program}`)
    child.unref()
  } finally {
    fs.closeSync(log)
  }
}

/** Kills the office's tmux session; says what was done, or null if there was no session. */
export async function stopTmux(launch: Launch, host: Host): Promise<string | null> {
  const name = session(launch)
  if ((await host.run(["tmux", "has-session", "-t", `=${name}`])).code !== 0) return null
  await host.run(["tmux", "kill-session", "-t", `=${name}`])
  return `tmux: killed the session ${name}`
}

/** The pid in the office's pidfile (a regular file, not a symlink, holding a decimal pid), or null. */
function pidOf(launch: Launch): number | null {
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

/** Stops the office's daemon with SIGTERM, then SIGKILL after `timeoutMs`; says what was done, or null if none
 *  runs. Nothing is signalled unless the pid's start time and args are this office's daemon's. */
export async function stopProcess(
  launch: Launch,
  { timeoutMs = 15_000, ps = resolveTools(daemonEnv(process.env)).ps }: { timeoutMs?: number; ps?: string } = {},
): Promise<string | null> {
  const found = daemon(launch, ps)
  if (found === null) return null
  if (!(await stopPid(found.pid, found.started, { timeout: timeoutMs }))) return null
  return `stopped the office (pid ${found.pid})`
}

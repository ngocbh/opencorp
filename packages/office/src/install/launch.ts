/** How the office daemon is started: its command, environment, folder and log, the host it runs on, and the
 *  check that pins a running daemon to them. Imports only `node:*`, `platform.ts` and `daemon/sockets.ts`:
 *  `daemonMain` runs `pinDaemon` before the daemon module loads. */
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { selfCommand } from "../platform.ts"

/** A service manager refused to install or start the office; the message says why. */
export class ServiceError extends Error {
  override name = "ServiceError"
}

/** One office's daemon: its launch command, environment and folder, and its service name. */
export class Launch {
  constructor(
    readonly argv: readonly string[],
    readonly env: Readonly<Record<string, string>>,
    readonly cwd: string,
    readonly home: string,
    readonly name: string,
  ) {}

  /** The office folder, `<home>/office`. */
  get office(): string {
    return path.join(this.home, "office")
  }

  /** Where the daemon's stdout and stderr go (never an unread pipe, which would stall it). */
  get log(): string {
    return path.join(this.office, "office.log")
  }

  /** The daemon's unix socket. */
  get socket(): string {
    return path.join(this.office, "office.sock")
  }
}

// The provider env and the key arrive with the run, never from here. SSL_CERT_FILE and SSL_CERT_DIR say where
// TLS finds CA certificates: some Linuxes (RHEL) don't fill the folder a bundled TLS stack looks in, so the owner
// points them at the system bundle.
/** The office env names both a worker and the daemon inherit (besides `LC_*`; the daemon adds `CODEX_ENV`, see
 *  `daemonEnv`). */
export const INHERITED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "TMPDIR",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const

/** Which Codex the office runs, when the caller's shell sets them: its home, and a binary other than `codex`. */
export const CODEX_ENV = ["CODEX_HOME", "OPENCORP_CODEX_BIN"] as const

/** An environment as `process.env` holds it. */
export type Env = Record<string, string | undefined>

/**
 * The daemon's environment: the worker allowlist, `LC_*` and `CODEX_ENV`, so no key in the caller's shell
 * reaches it. `PATH` keeps only its absolute entries, and is left out when none is.
 *
 * `LC_TERMINAL*` (iTerm's name and version) is left out: it isn't a locale, and it would change the service file
 * whenever the terminal updates. A relative `PATH` entry would refuse every workspace and let a cwd shadow a
 * tool; an empty `PATH` searches the cwd.
 */
export function daemonEnv(environ: Env): Record<string, string> {
  const kept: readonly string[] = [...INHERITED_ENV, ...CODEX_ENV]
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(environ)) {
    if (value === undefined) continue
    if (kept.includes(key) || (key.startsWith("LC_") && !key.startsWith("LC_TERMINAL"))) env[key] = value
  }
  if (env.PATH !== undefined) {
    const absolute = env.PATH.split(":").filter((entry) => entry.startsWith("/"))
    if (absolute.length) env.PATH = absolute.join(":")
    else delete env.PATH
  }
  return env
}

/** `value` as an absolute home path: a leading `~` is the user's home directory, and the nearest existing
 *  ancestor is resolved through its symlinks, with the rest (not created yet) appended. */
export function resolveHome(value: string): string {
  const expanded = value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value
  let dir = path.resolve(expanded)
  let rest = ""
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), rest)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const parent = path.dirname(dir)
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === dir) throw error
      rest = path.join(path.basename(dir), rest)
      dir = parent
    }
  }
}

/**
 * The launch for the office at `home`: `command` (the office's own, by default) with `daemon --home <home>`, run
 * in the office folder.
 *
 * The home is resolved as the daemon resolves `--home`, so both agree on the socket and pidfile. The default
 * home's service is `office`; any other home gets `office-<8 hex>` from its path, so a test or second office never
 * replaces the owner's service.
 */
export function launch(
  home: string,
  {
    command = selfCommand(),
    environ = process.env,
    userHome = os.homedir(),
  }: { command?: readonly string[]; environ?: Env; userHome?: string } = {},
): Launch {
  const real = resolveHome(home)
  const name =
    real === resolveHome(path.join(userHome, ".opencorp"))
      ? "office"
      : `office-${createHash("sha256").update(real, "utf8").digest("hex").slice(0, 8)}`
  return new Launch([...command, "daemon", "--home", real], daemonEnv(environ), path.join(real, "office"), real, name)
}

/** A finished command: its exit code and its output. */
export interface Completed {
  code: number
  stdout: string
  stderr: string
}

/**
 * Runs `argv` with this process's environment and captures its output. A program that can't start is exit 127
 * and one still running after `timeoutMs` is killed and exit 124, not an exception: the output it wrote before
 * the kill is kept, and stderr becomes `<argv[0]> timed out`. One killed by a signal is minus the signal's number.
 */
export function runCommand(argv: readonly [string, ...string[]], { timeoutMs = 60_000 } = {}): Promise<Completed> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let failed = false
    let timedOut = false
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk))
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
      // A grandchild may hold the pipes open; closing our ends lets `close` follow the child's own exit.
      child.stdout!.destroy()
      child.stderr!.destroy()
    }, timeoutMs)
    child.on("error", (error) => {
      // A program that never started (ENOENT, EACCES); a failed kill also lands here and is ignored.
      if (child.pid !== undefined) return
      failed = true
      clearTimeout(timer)
      resolve({ code: 127, stdout: "", stderr: error.message })
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      if (failed) return
      if (timedOut) resolve({ code: 124, stdout, stderr: `${argv[0]} timed out` })
      else resolve({ code: code ?? (signal ? -os.constants.signals[signal] : 0), stdout, stderr })
    })
  })
}

/** Whether an office is serving on `socket`: its open `GET /health` answers 200 within `timeoutMs`. */
export async function officeAnswers(socket: string, timeoutMs = 2000): Promise<boolean> {
  try {
    // Bun's fetch over a unix socket.
    const res = await fetch("http://office/health", { unix: socket, signal: AbortSignal.timeout(timeoutMs) })
    await res.arrayBuffer()
    return res.status === 200
  } catch {
    return false
  }
}

/** What installing touches on this machine: the platform, the user's home, and how to run things. Tests pass
 *  stand-ins (`tests/install/helpers.ts`). */
export interface Host {
  /** The platform the service is installed for. */
  platform: NodeJS.Platform
  /** The user's home directory, where per-user service files go. */
  userHome: string
  /** The user's id, which names launchd's per-user domain (`gui/<uid>`). */
  uid: number
  /** Runs a command and captures its output (`runCommand`). */
  run(argv: readonly [string, ...string[]]): Promise<Completed>
  /** Starts a process without waiting for it (the fallback daemon). */
  spawn(argv: readonly [string, ...string[]], options: SpawnOptions): ChildProcess
  /** The path of the program `name` on the user's `PATH`, or null. */
  which(name: string): string | null
  /** Waits `ms` milliseconds. */
  sleep(ms: number): Promise<void>
  /** A monotonic clock in milliseconds. */
  clock(): number
  /** Whether the office on `socket` answers within `timeoutMs` (`officeAnswers`). */
  answers(socket: string, timeoutMs?: number): Promise<boolean>
}

/** Whether `file` is a non-directory this process may execute. */
function runnable(file: string): boolean {
  try {
    if (fs.statSync(file).isDirectory()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The program `name` as `searchPath` (a `PATH` value) finds it, or null. A name holding `/` is itself when absolute
 * and runnable; otherwise the first absolute entry holding a runnable non-directory `name` answers, as
 * `<entry>/<name>`. Links are not resolved; a caller that needs the realpath resolves it.
 */
export function which(name: string, searchPath: string | undefined): string | null {
  if (name.includes("/")) return name.startsWith("/") && runnable(name) ? name : null
  for (const entry of (searchPath ?? "").split(":")) {
    if (entry.startsWith("/") && runnable(`${entry}/${name}`)) return `${entry}/${name}`
  }
  return null
}

/** This machine as installing sees it: setup runs as the user, on the user's `PATH`. */
export function defaultHost(): Host {
  return {
    platform: process.platform,
    userHome: os.homedir(),
    uid: process.getuid?.() ?? -1,
    run: runCommand,
    spawn: (argv, options) => spawn(argv[0], argv.slice(1), options),
    which: (name) => which(name, process.env.PATH),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    clock: () => performance.now(),
    answers: officeAnswers,
  }
}

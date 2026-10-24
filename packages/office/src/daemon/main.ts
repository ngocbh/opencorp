/** The daemon process: one daemon per home, held by a lock beside its pidfile; its start, its stop on a signal,
 *  and its log. */
import fs from "node:fs"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import os from "node:os"
import path from "node:path"
import { type FileLock, FileLockError, waitForLock } from "@ngocbh/yian/platform"
import { CompanyGit } from "../company/git.ts"
import { HeadWatcher } from "../company/watch.ts"
import { EXTENSIONS, type Extension, ExtensionError, loadExtensions } from "../extensions/index.ts"
import { daemonArgs, daemonEnv, resolveHome } from "../install/launch.ts"
import { type Tools, resolveTools, workspaceGuards } from "../install/tools.ts"
import type { OfficePaths as SandboxOfficePaths } from "../sandbox/policy.ts"
import { Store } from "../store/store.ts"
import { reap } from "../worker/reaper.ts"
import { DeviceTokens } from "./auth.ts"
import { Bus } from "./bus.ts"
import { type Level, createServer, logLine, requestListener } from "./http.ts"
import { Office, OfficePaths } from "./office.ts"
import { allRoutes } from "./routes/index.ts"
import { OfficeStartError, checkSocketPath, listenUnix, makeOfficeDir, removeStaleSocket } from "./sockets.ts"

/** How long a start waits for the home's lock before it reports the office already running: a busy
 *  result can be momentary (a probe or a racing start). */
export const LOCK_WAIT_MS = 1000

/** Another daemon holds this home's lock. */
export class AlreadyRunning extends OfficeStartError {
  override name = "AlreadyRunning"

  constructor(readonly pid: number | null) {
    super(`office already running (pid ${pid ?? "unknown"})`)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The pid the pidfile at `file` names, or null when it can't be read or holds no pid. */
function readPid(file: string): number | null {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  let text: string
  try {
    // O_NONBLOCK: a FIFO planted at the path can't hang the start.
    const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    try {
      const buffer = Buffer.alloc(32)
      text = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString().trim()
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  return /^\d+$/.test(text) ? Number(text) : null
}

/** The home's single-daemon lock (yian's lock on `office/office.lock`, held for the daemon's life) and
 *  the pidfile beside it, which names the holder. */
export class PidFile {
  #held: { lock: FileLock; fd: number } | undefined

  constructor(
    readonly path: string,
    readonly lockPath: string,
  ) {}

  /** Takes the lock and writes our pid, the pidfile made 0600. `AlreadyRunning` (with the pid the pidfile names,
   *  or null) when another holder has the lock; `OfficeStartError` for a pidfile that is a symlink, not a regular
   *  file or hard-linked, a lock file that isn't private, or another open failure. Never follows a symlink and
   *  never truncates another file. */
  async acquire(): Promise<void> {
    let lock: FileLock
    try {
      lock = await waitForLock(this.lockPath, { timeoutMs: LOCK_WAIT_MS, private: true })
    } catch (error) {
      if (error instanceof FileLockError) {
        if (error.reason === "busy") throw new AlreadyRunning(readPid(this.path))
        throw new OfficeStartError(error.message)
      }
      throw new OfficeStartError(`can't lock ${this.lockPath}: ${messageOf(error)}`)
    }
    const { O_RDWR, O_CREAT, O_NOFOLLOW } = fs.constants
    let fd: number
    try {
      fd = fs.openSync(this.path, O_RDWR | O_CREAT | O_NOFOLLOW, 0o600)
    } catch (error) {
      lock.release()
      const code = (error as NodeJS.ErrnoException).code
      // Linux and macOS say ELOOP for a symlink under O_NOFOLLOW; FreeBSD says EMLINK.
      if (code === "ELOOP" || code === "EMLINK") throw new OfficeStartError(`the pidfile ${this.path} is a symlink`)
      throw new OfficeStartError(`can't open the pidfile ${this.path}: ${messageOf(error)}`)
    }
    let stat: fs.Stats
    try {
      stat = fs.fstatSync(fd)
    } catch (error) {
      fs.closeSync(fd)
      lock.release()
      throw new OfficeStartError(`can't open the pidfile ${this.path}: ${messageOf(error)}`)
    }
    // A hard link would have our pid written through to another file.
    if (!stat.isFile() || stat.nlink !== 1) {
      fs.closeSync(fd)
      lock.release()
      throw new OfficeStartError(`the pidfile ${this.path} is not a regular file`)
    }
    try {
      // An existing pidfile keeps its mode through the open, so it is made private here.
      fs.fchmodSync(fd, 0o600)
      fs.ftruncateSync(fd, 0)
      fs.writeSync(fd, `${process.pid}\n`)
    } catch (error) {
      fs.closeSync(fd)
      lock.release()
      throw new OfficeStartError(`can't write the pidfile ${this.path}: ${messageOf(error)}`)
    }
    this.#held = { lock, fd }
  }

  /** Removes the pidfile and releases the lock; harmless when not held. */
  release(): void {
    const held = this.#held
    if (held === undefined) return
    try {
      fs.closeSync(held.fd)
      // Removed while the lock is still ours, so it can't remove a newer daemon's pidfile.
      fs.rmSync(this.path, { force: true })
    } finally {
      held.lock.release()
      this.#held = undefined
    }
  }
}

/** Writes text (lines with their newline) where the daemon's log goes: stderr by default. */
export type Write = (text: string) => void

/** Writes `text` to stderr synchronously, dropping it if the write fails. */
function writeStderr(text: string): void {
  try {
    fs.writeSync(2, text)
  } catch {
    // A full disk or a broken stderr pipe must not crash the office (Python's logging swallowed these errors too).
  }
}

/** A log function for `logger` at `level`: each message becomes one `logLine` on `write`. */
export function officeLogger(write: Write): (level: Level, logger: string) => (message: string) => void {
  return (level, logger) => (message) => write(logLine(level, logger, message) + "\n")
}

/** The error's type, as the office logs it: a message (or a settable `.name`) can quote a secret. */
function typeOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error
}

/** `<what>: <type>` as an ERROR line, then the stack's `at` frames, one per line; never the message. Never
 *  throws: if reading the error does, the report is the first line with the value's `typeof` and no frames. */
function failureReport(what: string, error: unknown): string {
  const first = (type: string) => logLine("ERROR", "opencorp.daemon.main", `${what}: ${type}`)
  try {
    const lines = [first(typeOf(error))]
    if (error instanceof Error && typeof error.stack === "string") {
      // The stack starts with `<name>: <message>`, and a name or message line can look like a frame, so the
      // header's lines go first.
      const header = `${String(error.name)}: ${String(error.message)}`.split("\n").length
      lines.push(...error.stack.split("\n").slice(header).filter((line) => /^\s+at /.test(line)))
    }
    return lines.join("\n") + "\n"
  } catch {
    return first(typeof error) + "\n"
  }
}

/** The crash marker for `error`: `logLine("ERROR", "opencorp.daemon.main", "office crashed: <type>")`, then
 *  the stack's `at` frames, one per line; never the message, which could quote a secret. */
export function crashReport(error: unknown): string {
  return failureReport("office crashed", error)
}

/**
 * Makes the first uncaught exception or unhandled rejection write the crash marker (`crashReport`) on `write`
 * (stderr by default) and exit 1 at once; a later one returns at once. Exiting at once is safe: the kernel frees
 * the home's lock with the process, and the next start removes the stale socket and reaps the workers this office
 * left. The marker never holds the error's message, which could quote a secret. The default write is synchronous,
 * so the line can't be lost to the exit when stderr is a pipe.
 */
export function exitOnCrash(write: Write = writeStderr): void {
  let crashed = false
  const onCrash = (error: unknown) => {
    if (crashed) return
    crashed = true
    try {
      write(crashReport(error))
    } catch {
      // A failing write has nowhere to be reported; the exit still happens.
    } finally {
      process.exit(1)
    }
  }
  process.on("uncaughtException", onCrash)
  process.on("unhandledRejection", onCrash)
}

// Names PATH, never its value (no env value in errors).
const NO_GIT = "no git on the office's PATH"

/** Opens the store and the company clone (run by `tools.git`), kills the processes an earlier office left, and
 *  assembles the office with its tools, its workspace guards and its HEAD watcher (started and stopped with the
 *  office). `OfficeStartError` when `tools` has no git. */
export function buildOffice(
  paths: OfficePaths,
  { tools, guards, write }: { tools: Tools; guards: SandboxOfficePaths; write: Write },
): Office {
  if (tools.git === undefined) throw new OfficeStartError(NO_GIT)
  const log = officeLogger(write)
  const store = new Store(paths.store, { log: log("ERROR", "opencorp.store") })
  try {
    const companyGit = new CompanyGit(paths.company, paths.worktrees, { git: tools.git })
    reap(store)
    const office = new Office({
      paths,
      store,
      git: companyGit,
      bus: new Bus(),
      tools,
      guards,
      log: log("ERROR", "opencorp.daemon.office"),
      connections: { log: log("WARNING", "opencorp.chat.connections") },
      models: { log: log("WARNING", "opencorp.chat.models") },
      logins: { log: log("WARNING", "opencorp.chat.logins") },
    })
    // Not awaited: a slow provider must not hold up the start. warm never rejects.
    office.onStart.push(() => void office.models.warm())
    // Bounded: closeAll waits at most STOP_WAIT_MS for the sign-ins to stop.
    office.onStop.push(() => office.logins.closeAll())
    const watcher = new HeadWatcher(office, { log: log("ERROR", "opencorp.company.watch") })
    office.onStart.push(() => watcher.start())
    office.onStop.push(() => watcher.stop())
    return office
  } catch (error) {
    store.close()
    throw error
  }
}

/** How long a stop waits for request handlers still running before the store closes. */
export const HANDLER_WAIT_MS = 5000

/** Wraps a request listener so the requests it is still handling can be awaited: `settled(ms)` resolves
 *  once every running handler has settled or after `ms`, whichever is first. */
export function trackRequests(listener: (req: IncomingMessage, res: ServerResponse) => Promise<void>): {
  listener: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  settled(ms: number): Promise<void>
} {
  const running = new Set<Promise<void>>()
  return {
    listener(req, res) {
      const handling: Promise<void> = listener(req, res).finally(() => running.delete(handling))
      running.add(handling)
      return handling
    },
    settled(ms) {
      return new Promise((resolve) => {
        // Ref'd: the stop's wait must keep the process alive until the store closes and the pidfile and lock go.
        const timer = setTimeout(resolve, ms)
        void Promise.allSettled(running).then(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
  }
}

const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const

/** Closes `server` and resolves once it has, whatever its callback reports, so the stop never skips the
 *  socket removal and the handler wait. */
function close(server: Server): Promise<void> {
  // closeAllConnections already stopped the listener on this runtime, so close reports ERR_SERVER_NOT_RUNNING.
  return new Promise((resolve) => server.close(() => resolve()))
}

/**
 * Runs the daemon for `paths` until SIGINT, SIGTERM or SIGHUP.
 *
 * The start: the office dir, the lock and pidfile, the stop signals (installed before anything opens, so a signal
 * during the start stops the office once it has started instead of killing the process mid-start), the company
 * repo and socket path checks, the tools (git required), the office (store, company clone, reaped workers), the
 * extensions, the office's start, and last the socket: it listens only once everything is ready. A failed start
 * undoes what it did, in reverse.
 *
 * The stop: the office stops first (its bus closes before anything else, because SSE responses never end on their
 * own, so the server's close isn't held by them), then the connections and the server close, the socket file goes,
 * request handlers still running get up to `HANDLER_WAIT_MS`, the store closes, and last the pidfile and lock.
 */
async function run(
  paths: OfficePaths,
  { extensions, write, tools: given }: { extensions: readonly Extension[]; write: Write; tools?: Tools },
): Promise<void> {
  const log = officeLogger(write)
  makeOfficeDir(paths.office)
  const pidfile = new PidFile(paths.pidfile, paths.lock)
  await pidfile.acquire()
  try {
    const { promise: stopped, resolve: stop } = Promise.withResolvers<void>()
    // Resolving twice does nothing, so the first signal wins.
    const onSignal = () => stop()
    for (const sig of STOP_SIGNALS) process.on(sig, onSignal)
    try {
      if (!fs.existsSync(path.join(paths.company, ".git")))
        throw new OfficeStartError(`no company repo at ${paths.company}`)
      checkSocketPath(paths.socket)
      // `main` can run without `pinDaemon` (tests); after the pin this filter changes nothing.
      const env = daemonEnv(process.env)
      const tools = given ?? resolveTools(env)
      const office = buildOffice(paths, { tools, guards: workspaceGuards(tools, env), write })
      try {
        try {
          loadExtensions(office, extensions)
        } catch (error) {
          if (error instanceof ExtensionError) throw new OfficeStartError(error.message)
          throw error
        }
        removeStaleSocket(paths.socket) // we hold the lock, so no live daemon owns it
        try {
          await office.start()
        } catch (error) {
          // start already stopped what earlier callbacks started.
          write(failureReport("the office failed to start", error))
          throw new OfficeStartError("the office failed to start (see the log above)")
        }
        const requests = trackRequests(
          requestListener(allRoutes(), {
            context: new DeviceTokens(office).context,
            log: (line) => write(line + "\n"),
          }),
        )
        const server = createServer(requests.listener)
        try {
          await listenUnix(server, paths.socket)
        } catch (error) {
          await office.stop()
          throw error
        }
        server.on("error", (error) => log("ERROR", "opencorp.daemon.main")(`office socket error: ${typeOf(error)}`))
        log("INFO", "opencorp.daemon.main")(`office serving on ${paths.socket}`)
        await stopped
        try {
          await office.stop()
        } finally {
          server.closeAllConnections()
          await close(server)
          fs.rmSync(paths.socket, { force: true })
          await requests.settled(HANDLER_WAIT_MS)
        }
      } finally {
        office.store.close()
      }
    } finally {
      for (const sig of STOP_SIGNALS) process.off(sig, onSignal)
    }
  } finally {
    pidfile.release()
  }
}

export interface MainOptions {
  /** The extensions to load (default `EXTENSIONS`). */
  extensions?: readonly Extension[]
  /** Where log lines and start errors go (default stderr). */
  write?: Write
  /** The programs the daemon runs, as absolute realpaths (default `resolveTools` on the daemon's `PATH`). */
  tools?: Tools
}

/**
 * Runs the daemon for `--home` (default `~/.opencorp`) until SIGINT, SIGTERM or SIGHUP; resolves to the exit
 * code: 0 after a clean stop or when this home's office is already running (a service manager restarts only on
 * failure, so a duplicate start must not look like one), 1 when it can't start or crashed, 2 for bad arguments.
 *
 * On a signal the office stops first, its bus before anything else (SSE responses never end on their own, so they
 * would hold the server's close); then the server and the socket file, the handlers still running (up to
 * `HANDLER_WAIT_MS`), the store, and the pidfile and lock. Writes are synchronous by default: the process exits as
 * soon as this returns, so nothing may wait in a stream buffer.
 *
 * The tools are resolved once at start, to absolute realpaths; nothing is looked up by name later.
 */
export async function main(
  argv: string[],
  { extensions = EXTENSIONS, write = writeStderr, tools }: MainOptions = {},
): Promise<number> {
  let value: string | undefined
  try {
    // `--reexeced` marks the re-exec `pinDaemon` already checked; nothing here reads it.
    value = daemonArgs(argv).home
  } catch (error) {
    write(`opencorp office: ${messageOf(error)}\n`)
    return 2
  }
  try {
    const wanted = value ?? path.join(os.homedir(), ".opencorp")
    let home: string
    try {
      home = resolveHome(wanted)
    } catch (error) {
      throw new OfficeStartError(`can't resolve the home ${wanted}: ${messageOf(error)}`)
    }
    await run(new OfficePaths(home), { extensions, write, tools })
    return 0
  } catch (error) {
    if (error instanceof AlreadyRunning) {
      write(`opencorp office: ${error.message}\n`)
      return 0
    }
    if (error instanceof OfficeStartError) {
      write(`opencorp office: ${error.message}\n`)
      return 1
    }
    write(crashReport(error))
    return 1
  }
}

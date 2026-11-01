/** The daemon process: one daemon per home, held by a lock beside its pidfile; its start, its stop on a signal,
 *  and its log. */
import fs from "node:fs"
import type { Server } from "node:http"
import os from "node:os"
import { type FileLock, FileLockError, waitForLock } from "@ngocbh/yian/platform"
import { oneReplyProblem } from "../chat/check.ts"
import { ChatHarness } from "../chat/harness.ts"
import { Hooks } from "../chat/hooks.ts"
import { Transcript } from "../chat/transcript.ts"
import { CompanyGit } from "../company/git.ts"
import { HeadWatcher } from "../company/watch.ts"
import { EXTENSIONS, type Extension, ExtensionError, loadExtensions } from "../extensions/index.ts"
import { CodexSessions } from "../harness/sessions.ts"
import { attach } from "../hq/core.ts"
import { daemonArgs, daemonEnv, requireCompany, resolveHome, wantedHome } from "../install/launch.ts"
import { args, isDaemonLine, startTime } from "../install/proc.ts"
import { type Tools, resolveTools, workspaceGuards } from "../install/tools.ts"
import { Monitor } from "../perm/monitor.ts"
import { selfCommand } from "../platform.ts"
import { Inspections, YianRuns, sweep } from "../runs/records.ts"
import type { OfficePaths as SandboxOfficePaths } from "../sandbox/policy.ts"
import { storeProblem } from "../store/problem.ts"
import { Store } from "../store/store.ts"
import { reap } from "../worker/reaper.ts"
import { WorkerRegistry } from "../worker/spawn.ts"
import { Bus } from "./bus.ts"
import {
  HANDLER_WAIT_MS,
  type Level,
  createServer,
  errorType,
  logLine,
  requestListener,
  trackRequests,
} from "./http.ts"
import { LiveRelay } from "./live.ts"
import { Office, OfficePaths } from "./office.ts"
import { allRoutes } from "./routes/index.ts"
import {
  OfficeStartError,
  type SocketId,
  checkSocketPath,
  listenUnix,
  makeOfficeDir,
  messageOf,
  probeSocket,
  removeOwnSocket,
  removeStaleSocket,
} from "./sockets.ts"

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

  /** Takes the lock, runs `check` with the pid the pidfile names (or null), then writes our pid, the pidfile made
   *  0600. `AlreadyRunning` (with the pid the pidfile names, or null) when another holder has the lock; what `check`
   *  throws, with the lock released and the pidfile untouched; `OfficeStartError` for a pidfile that is a symlink,
   *  not a regular file or hard-linked, a lock file that isn't private, or another open failure. Never follows a
   *  symlink and never truncates another file. */
  async acquire(check?: (pid: number | null) => Promise<void>): Promise<void> {
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
    try {
      await check?.(readPid(this.path))
    } catch (error) {
      lock.release()
      throw error
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

  /** Removes the pidfile if it is still the file this holder wrote, and releases the lock; harmless when not held.
   *  False when another file was at the path, which is left; true otherwise. */
  release(): boolean {
    const held = this.#held
    if (held === undefined) return true
    try {
      // Compared by inode, not by the lock: a lock file deleted and made again lets a second daemon in, and its
      // pidfile must stay.
      let ours: boolean
      try {
        const mine = fs.fstatSync(held.fd, { bigint: true })
        const st = fs.lstatSync(this.path, { bigint: true, throwIfNoEntry: false })
        ours = st === undefined || (st.dev === mine.dev && st.ino === mine.ino)
      } finally {
        fs.closeSync(held.fd)
      }
      if (ours) fs.rmSync(this.path, { force: true })
      return ours
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

/** `<what>: <type>` as an ERROR line, then the stack's `at` frames, one per line; never the message. Never
 *  throws: if reading the error does, the report is the first line with the value's `typeof` and no frames. */
function failureReport(what: string, error: unknown): string {
  const first = (type: string) => logLine("ERROR", "opencorp.daemon.main", `${what}: ${type}`)
  try {
    const lines = [first(errorType(error))]
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

/** How long the start waits for the run index to be brought up to date; under `service.wait`'s 20 s, since the
 *  socket listens only after the start callbacks. */
const START_INDEX_MS = 10_000

/** Brings the run index up to date, waiting at most `START_INDEX_MS` (the update goes on past that), then sweeps
 *  the runs an earlier office left open. The sweep runs only on an up-to-date index: without one it would read every
 *  run log yian ended, and those rows show interrupted until a later start sweeps them. A failure is logged by its
 *  type: a broken or hung index never stops the start. */
async function sweepOnStart(office: Office, log: ReturnType<typeof officeLogger>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const waited = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), START_INDEX_MS)
      timer.unref()
    })
    if (!(await Promise.race([office.runIndex.update(), waited]))) {
      log("WARNING", "opencorp.daemon.main")("the start sweep was skipped (the run index is not up to date)")
      return
    }
    // The rows the update just read, on the index thread.
    sweep(office.store, new YianRuns(office.runIndex.rows(), new Inspections(office.paths.runs)))
  } catch (error) {
    log("ERROR", "opencorp.daemon.main")(`the start sweep failed: ${errorType(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

/** `step`'s result; a store trouble it throws (`storeProblem`) becomes an `OfficeStartError` that names it, so the
 *  start says why instead of logging a crash with only the error's type. */
function openStore<T>(file: string, step: () => T): T {
  try {
    return step()
  } catch (error) {
    const problem = storeProblem(file, error)
    if (problem === null) throw error
    throw new OfficeStartError(problem)
  }
}

/** Opens the store and the company clone (run by `tools.git`), kills the processes an earlier office left, and
 *  assembles the office with its tools, its workspace guards, its worker registry (each worker's exit updates the
 *  run index; the one-reply model check runs over it), its run transcript and live relay (for the session actors;
 *  the relay's viewers end on stop), its Codex sessions on the chat hooks, and the chat harness over the registry
 *  with a `Monitor`: the harness is the office's workers and its session harness, so the office's stop closes it
 *  first (the Codex sessions, then the workers). On start: the run index brought up to date and the start sweep,
 *  then the harness's restore (before the extensions' start callbacks), then a model warm-up (not awaited) and the
 *  HEAD watcher; on stop, the sign-ins still waiting are cancelled and the watcher stops. `OfficeStartError` when
 *  `tools` has no git, or the store can't be opened or read (`storeProblem`). */
export function buildOffice(
  paths: OfficePaths,
  { tools, guards, write }: { tools: Tools; guards: SandboxOfficePaths; write: Write },
): Office {
  if (tools.git === undefined) throw new OfficeStartError(NO_GIT)
  const log = officeLogger(write)
  const store = openStore(paths.store, () => new Store(paths.store, { log: log("ERROR", "opencorp.store") }))
  try {
    const companyGit = new CompanyGit(paths.company, paths.worktrees, {
      git: tools.git,
      log: log("WARNING", "opencorp.company.git"),
    })
    // A store that opened can still fail its first queries (a corrupt page), and the reap runs them first.
    openStore(paths.store, () => reap(store))
    const workers = new WorkerRegistry(store, {
      log: (level, line) => log(level, "opencorp.worker.spawn")(line),
      // update never rejects.
      onExit: () => void office.runIndex.update(),
    })
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
      checkModel: (provider) => oneReplyProblem(workers, provider, { log: log("WARNING", "opencorp.chat.check") }),
      runIndex: { log: log("WARNING", "opencorp.runs.indexer") },
    })
    // Bounded: closeAll waits at most STOP_WAIT_MS for the sign-ins to stop.
    office.onStop.push(() => office.logins.closeAll())
    office.transcript = new Transcript(paths.runs)
    office.live = new LiveRelay({
      bus: office.bus,
      transcript: office.transcript,
      log: log("WARNING", "opencorp.daemon.live"),
    })
    // Ends the run viewers; the workers that fed the relay are stopped by then.
    office.onStop.push(() => office.live?.close())
    const hooks = new Hooks({ log: log("ERROR", "opencorp.chat.hooks") })
    office.codex = new CodexSessions(office, hooks, { log: log("WARNING", "opencorp.harness.session") })
    const monitor = new Monitor(paths.company, store, office.secrets)
    // After the transcript and the relay, which its actors share.
    const harness = new ChatHarness(office, { monitor, hooks, workers, log: log("WARNING", "opencorp.chat.harness") })
    // Office.stop closes its workers first: the harness's stop closes the Codex sessions, then the registry.
    office.workers = harness
    office.harness = harness
    // Before the restore, as Python's restore swept first: the sweep must never end a run a restore resumes or starts.
    office.onStart.push(() => sweepOnStart(office, log))
    // Before loadExtensions adds the cards' sweep, so the sweep sees the statuses restore settled.
    office.onStart.push(() => harness.restore())
    // Not awaited: a slow provider must not hold up the start. warm never rejects.
    office.onStart.push(() => void office.models.warm())
    const watcher = new HeadWatcher(office, { log: log("ERROR", "opencorp.company.watch") })
    office.onStart.push(() => watcher.start())
    office.onStop.push(() => watcher.stop())
    return office
  } catch (error) {
    store.close()
    throw error
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
 * Throws `AlreadyRunning` when another office still serves this home although its lock was free (office.lock was
 * deleted, and yian's lock holds only while the path names the same file): `pid`, the pidfile's, is a live
 * `daemon --home <home>` process (read with `ps`), or office.sock or hq.sock has a listener. A socket that can't be
 * probed is an `OfficeStartError`, so a service manager tries again. Otherwise removes a stale office.sock. A
 * non-socket at either path is left for `removeStaleSocket` (office.sock) or HQ (hq.sock) to report.
 */
async function refuseLiveDaemon(paths: OfficePaths, pid: number | null, ps: string | undefined): Promise<void> {
  // startTime spawns nothing, so ps runs only for a live pid.
  const alive = pid !== null && pid !== process.pid && startTime(pid) !== null
  if (alive && ps !== undefined && isDaemonLine(args(pid, ps), paths.home)) throw new AlreadyRunning(pid)
  for (const sock of [paths.socket, paths.hqSocket]) {
    if (!fs.lstatSync(sock, { throwIfNoEntry: false })?.isSocket()) continue
    const state = await probeSocket(sock)
    if (state === "live") throw new AlreadyRunning(alive ? pid : null)
    if (state === "unknown") throw new OfficeStartError(`can't tell whether ${sock} is in use`)
  }
  await removeStaleSocket(paths.socket)
}

/**
 * Runs the daemon for `paths` until SIGINT, SIGTERM or SIGHUP.
 *
 * The start: the company repo check (first, so a start on a home without one makes nothing), the office dir, the
 * socket path check, the tools, the lock, the check that no other office still serves this home (`refuseLiveDaemon`,
 * before anything is written; it also removes a stale socket), the pidfile, the stop signals (installed before
 * anything opens, so a signal during the start stops the office once it has started instead of killing the process
 * mid-start), the office (git required; store, company clone, reaped workers), the extensions, HQ (attached last, so
 * its listeners start after everything else and stop first), the office's start, and last the socket: it listens
 * only once everything is ready. A failed start undoes what it did, in reverse.
 *
 * The stop: the office stops first (its bus closes before anything else, because SSE responses never end on their
 * own, so the handler wait isn't held by them), then the server takes no new connections and idle ones close,
 * request handlers still running get up to `HANDLER_WAIT_MS` to answer, the remaining connections and the server
 * close, the socket file goes (only if it is still this office's), the store closes, and last the pidfile (likewise)
 * and lock.
 */
async function run(
  paths: OfficePaths,
  { extensions, write, tools: given }: { extensions: readonly Extension[]; write: Write; tools?: Tools },
): Promise<void> {
  const log = officeLogger(write)
  // First, unlike design §2.3's order (office dir, lock, then this check), so a start on a home without a company
  // makes nothing there.
  requireCompany(paths.home)
  makeOfficeDir(paths.office)
  checkSocketPath(paths.socket)
  // `main` can run without `pinDaemon` (tests); after the pin this filter changes nothing.
  const env = daemonEnv(process.env)
  const tools = given ?? resolveTools(env)
  const pidfile = new PidFile(paths.pidfile, paths.lock)
  // Before the pidfile is written and before buildOffice: its reap would kill a live office's workers, and its
  // migrations would touch that office's store.
  await pidfile.acquire((pid) => refuseLiveDaemon(paths, pid, tools.ps))
  try {
    const { promise: stopped, resolve: stop } = Promise.withResolvers<void>()
    // Resolving twice does nothing, so the first signal wins.
    const onSignal = () => stop()
    for (const sig of STOP_SIGNALS) process.on(sig, onSignal)
    try {
      // A tool's install folder is write-denied in every sandboxed call, so it must not take in the office's
      // worktrees, the sessions' tmpdirs or the temp folder the calls' canaries go in.
      const guards = workspaceGuards(tools, env, selfCommand(), [os.homedir(), paths.home, os.tmpdir()])
      const office = buildOffice(paths, { tools, guards, write })
      try {
        try {
          loadExtensions(office, extensions)
        } catch (error) {
          if (error instanceof ExtensionError) throw new OfficeStartError(error.message)
          throw error
        }
        // Last, so HQ starts after everything else and stops first.
        attach(office, { log: (line) => write(line + "\n") })
        try {
          await office.start()
        } catch (error) {
          // start already stopped what earlier callbacks started.
          write(failureReport("the office failed to start", error))
          throw new OfficeStartError("the office failed to start (see the log above)")
        }
        const requests = trackRequests(
          requestListener(allRoutes(), {
            context: office.tokens.context,
            log: (line) => write(line + "\n"),
          }),
        )
        const server = createServer(requests.listener)
        let socketId: SocketId
        try {
          socketId = await listenUnix(server, paths.socket)
        } catch (error) {
          await office.stop()
          throw error
        }
        server.on("error", (error) => log("ERROR", "opencorp.daemon.main")(`office socket error: ${errorType(error)}`))
        log("INFO", "opencorp.daemon.main")(`office serving on ${paths.socket}`)
        await stopped
        try {
          await office.stop()
        } finally {
          // No new connections while running handlers answer (503 stopping): a request on an idle keep-alive
          // connection would start a handler the closing below cuts. Not close() yet: on this runtime a close()
          // before closeAllConnections() leaves the open connections open.
          server.maxConnections = 0
          server.closeIdleConnections()
          // Settled before closing, so a handler still running isn't cut off before its reply. The office's stop
          // already ended the event and live streams, which never end on their own.
          await requests.settled(HANDLER_WAIT_MS)
          server.closeAllConnections()
          await close(server)
          if (!removeOwnSocket(paths.socket, socketId))
            log("WARNING", "opencorp.daemon.main")(`left ${paths.socket}: it is no longer this office's socket`)
        }
      } finally {
        office.store.close()
      }
    } finally {
      for (const sig of STOP_SIGNALS) process.off(sig, onSignal)
    }
  } finally {
    if (!pidfile.release())
      log("WARNING", "opencorp.daemon.main")(`left ${paths.pidfile}: it is no longer this office's pidfile`)
  }
}

export interface MainOptions {
  /** The extensions to load (default `EXTENSIONS`). */
  extensions?: readonly Extension[]
  /** Where log lines and start errors go (default stderr). */
  write?: Write
  /** The programs the daemon runs, as the absolute paths found on the daemon's PATH (default `resolveTools`). */
  tools?: Tools
}

/**
 * Runs the daemon for `--home` (default `$OPENCORP_HOME`, else `~/.opencorp`: `wantedHome`) until SIGINT, SIGTERM or SIGHUP; resolves to the exit
 * code: 0 after a clean stop or when this home's office is already running (a service manager restarts only on
 * failure, so a duplicate start must not look like one), 1 when it can't start or crashed, 2 for bad arguments.
 * The start and stop are `run`'s. Writes are synchronous by default: the process exits as soon as this returns, so
 * nothing may wait in a stream buffer.
 *
 * The tools are resolved once at start, as the absolute paths found on the daemon's PATH; nothing is looked up by
 * name later.
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
    const wanted = wantedHome(value, process.env)
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

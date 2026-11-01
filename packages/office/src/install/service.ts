/**
 * Installing and starting the office under the best service manager that works here.
 *
 * The mode that worked is recorded in `office/install.json` so the office is started the same way later, and so a
 * running office is never handed to a second manager (two daemons would fight over the pidfile, and launchd or
 * systemd would restart the loser).
 */
import fs from "node:fs"
import path from "node:path"
import { OfficeInfo } from "@opencorp/protocol"
import { type Identity, identityPath, readIdentity } from "../auth/identity.ts"
import { makeOfficeDir } from "../daemon/sockets.ts"
import * as fallback from "./fallback.ts"
import { readRegular, writeIfChanged } from "./files.ts"
import { daemonEnv, type Host, type Launch, ServiceError } from "./launch.ts"
import * as launchd from "./launchd.ts"
import * as systemd from "./systemd.ts"
import { resolveTools } from "./tools.ts"

/** The modes the office runs under, in the order `install` tries them. */
export const MODES = ["launchd", "systemd", "tmux", "background"] as const

/** One of `MODES`. */
export type Mode = (typeof MODES)[number]

type Step = (launch: Launch, host: Host) => Promise<void> | void
/** Why the manager doesn't have the office's service, or null if it does. */
type Check = (launch: Launch, host: Host) => Promise<string | null>

/** How each managed mode installs and starts the office; the background is `fallback.startBackground`, whose child
 *  the caller keeps. */
const INSTALL: Record<Exclude<Mode, "background">, Step> = {
  launchd: launchd.install,
  systemd: systemd.install,
  tmux: fallback.startTmux,
}
const START: Record<Exclude<Mode, "background">, Step> = {
  launchd: launchd.start,
  systemd: systemd.start,
  tmux: fallback.startTmux,
}
const NOT_MANAGED: Partial<Record<Mode, Check>> = {
  launchd: launchd.notLoaded,
  systemd: systemd.notEnabled,
}

/** The mode the office runs under (null if it was already running unmanaged), why others were skipped, and the
 *  daemon a background start just spawned. */
export interface Installed {
  mode: Mode | null
  notes: string[]
  child?: fallback.BackgroundChild
}

function isMode(value: unknown): value is Mode {
  return (MODES as readonly unknown[]).includes(value)
}

/** The most of `install.json` read: its record is about 50 bytes. */
const RECORD_CAP = 4096

/** The mode `install` last recorded for this office, if any; a record that isn't a regular file counts as none. */
export function recordedMode(launch: Launch): Mode | null {
  try {
    const bytes = readRegular(path.join(launch.office, "install.json"), RECORD_CAP)
    if (bytes === null) return null
    const parsed: unknown = JSON.parse(bytes.toString("utf8"))
    const mode = parsed !== null && typeof parsed === "object" ? (parsed as { mode?: unknown }).mode : undefined
    return isMode(mode) ? mode : null
  } catch {
    return null
  }
}

function record(launch: Launch, mode: Mode): void {
  writeIfChanged(path.join(launch.office, "install.json"), `${JSON.stringify({ mode, name: launch.name }, null, 2)}\n`)
}

function order(host: Host): Mode[] {
  const native: Mode[] = host.platform === "darwin" ? ["launchd"] : host.platform === "linux" ? ["systemd"] : []
  return [...native, ...(host.which("tmux") ? (["tmux"] as const) : []), "background"]
}

/** The pid in the office's pidfile, or `?` if there is none, or it isn't a regular file holding a decimal pid. */
export function pid(launch: Launch): number | "?" {
  return fallback.pidOf(launch) ?? "?"
}

/** Why the office's answer couldn't be read: it refused this device's token; no office answered in time (or one too
 *  old to have the route); or its answer isn't what was asked for. */
export type Unread = "refused" | "unreachable" | "unreadable"

/**
 * `GET <target>` from the office on `socket`, sent with the identity's token when there is one: the status and body
 * text, or `unreachable` when nothing answered within `timeoutMs`.
 */
export async function getJson(
  socket: string,
  identity: Identity | undefined,
  target: string,
  timeoutMs: number,
): Promise<{ status: number; text: string } | "unreachable"> {
  try {
    // Bun's fetch over a unix socket.
    const res = await fetch(`http://office${target}`, {
      unix: socket,
      headers: identity?.headers(),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { status: res.status, text: await res.text() }
  } catch {
    return "unreachable"
  }
}

/**
 * `GET target` from the office on `socket`, sent with the identity's token when there is one, and its JSON body as
 * `read` takes it, or why it couldn't be read (`read` returning undefined makes it unreadable).
 */
export async function readFromOffice<T>(
  socket: string,
  identity: Identity | undefined,
  target: string,
  timeoutMs: number,
  read: (body: unknown) => T | undefined,
): Promise<T | Unread> {
  const got = await getJson(socket, identity, target, timeoutMs)
  if (got === "unreachable") return got
  if (got.status === 401) return "refused"
  // 404 from an office before the route; for /hq, 501 from one without HQ attached
  if (got.status !== 200) return "unreachable"
  let body: unknown
  try {
    body = JSON.parse(got.text)
  } catch {
    return "unreadable"
  }
  return read(body) ?? "unreadable"
}

/**
 * `GET /office` from the office on `socket`, sent with the identity's token when there is one: its pid, home, start
 * time, version and pinned tools, or why it couldn't be read.
 */
export async function officeInfo(
  socket: string,
  identity: Identity | undefined,
  timeoutMs = 2000,
): Promise<OfficeInfo | Unread> {
  return readFromOffice(socket, identity, "/office", timeoutMs, (body) => OfficeInfo.safeParse(body).data)
}

/** The office's daemon as `findDaemon` found it: the process to stop (null when none could be verified as this
 *  office's daemon), the pid its source named, the source (`GET /office`, or the pidfile when the office didn't
 *  say), and whether there was a `ps` to verify it with. */
export interface Lookup {
  daemon: { pid: number; started: number } | null
  named: number | null
  from: "office" | "pidfile" | null
  checked: boolean
}

/** What `findDaemon` reads and runs; tests pass stand-ins. */
export interface LookupOptions {
  /** The `ps` that checks a pid's args, or null for none (default the one on the daemon's PATH). */
  ps?: string | null
  /** `GET /office` from the office on the socket (default `officeInfo`). */
  office?: (socket: string, identity: Identity | undefined) => Promise<OfficeInfo | Unread>
  /** This device's identity, or undefined (default read from `<home>/identity.json`). */
  identity?: () => Promise<Identity | undefined>
  /** How long the identity may take before the office is asked without it (default 5 s). */
  identityTimeoutMs?: number
}

/**
 * The pid the office says it has: asked with `GET /office` and this device's token when its socket is a socket (not a
 * symlink to one) and it answers, and only when it serves this home; null otherwise. Nothing is verified here.
 *
 * The identity's read can wait on a busy lock for 30 s; after `identityTimeoutMs` the office is asked without it,
 * which an office with devices refuses.
 */
export async function officePid(
  launch: Launch,
  host: Host,
  {
    office = officeInfo,
    identity = () => readIdentity(identityPath(launch.home)),
    identityTimeoutMs = 5000,
  }: Omit<LookupOptions, "ps"> = {},
): Promise<number | null> {
  let isSocket = false
  try {
    isSocket = fs.lstatSync(launch.socket).isSocket()
  } catch {}
  if (!isSocket || !(await host.answers(launch.socket))) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), identityTimeoutMs)
  })
  const me = await Promise.race([identity().catch(() => undefined), late]).finally(() => clearTimeout(timer))
  const info = await office(launch.socket, me)
  return typeof info !== "string" && info.home === launch.home ? info.pid : null
}

/**
 * Finds the office's daemon: the pid `officePid` reads from the office, so a pidfile that is missing or wrong doesn't
 * hide it, else the pidfile's when the office doesn't answer, won't say, or serves another home. Either pid counts as
 * the daemon only once its start time and args show it is this office's (`fallback.verify`), so nothing else is ever
 * signalled.
 */
export async function findDaemon(
  launch: Launch,
  host: Host,
  { ps = resolveTools(daemonEnv(process.env)).ps, ...asking }: LookupOptions = {},
): Promise<Lookup> {
  const checked = typeof ps === "string"
  const verified = (pid: number) => (typeof ps === "string" ? fallback.verify(pid, launch, ps) : null)
  const said = await officePid(launch, host, asking)
  if (said !== null) return { daemon: verified(said), named: said, from: "office", checked }
  const named = fallback.pidOf(launch)
  if (named === null) return { daemon: null, named: null, from: null, checked }
  return { daemon: verified(named), named, from: "pidfile", checked }
}

/**
 * Installs the office under `mode`, or under the first that works when `mode` is `auto`.
 *
 * A running office stays under the mode it was recorded with; asking for another throws `ServiceError`, and one
 * started by hand is left alone with nothing installed. A running office's launchd or systemd service is only
 * checked, never rewritten: the new file would differ with the caller's environment, and loading it would restart
 * the office. The office dir is made before any manager is tried, since each starts the daemon in it.
 *
 * Throws `ServiceError` if the chosen mode, or the last one tried, failed, and `OfficeStartError` for an office dir
 * that isn't ours.
 */
export async function install(launch: Launch, host: Host, mode: Mode | "auto" = "auto"): Promise<Installed> {
  const recorded = recordedMode(launch)
  let candidates: Mode[]
  if (await host.answers(launch.socket)) {
    if (recorded === null) {
      return {
        mode: null,
        notes: [
          `the office is already running (pid ${pid(launch)}) but was not started by` +
            " a service; run `opencorp stop`, then `opencorp onboard` again to install one",
        ],
      }
    }
    if (mode !== "auto" && mode !== recorded) {
      throw new ServiceError(
        `the office is already running under ${recorded}; run \`opencorp stop\` before moving it to ${mode}`,
      )
    }
    const notManaged = NOT_MANAGED[recorded]
    if (notManaged !== undefined) {
      const problem = await notManaged(launch, host)
      if (problem !== null) {
        throw new ServiceError(
          `the office is running, but ${recorded} doesn't have its service (${problem});` +
            " run `opencorp stop`, then `opencorp onboard` again",
        )
      }
      return { mode: recorded, notes: [] }
    }
    // Nothing to bring up to date, and starting it again would only spawn a daemon that exits.
    if (recorded === "background") return { mode: recorded, notes: [] }
    candidates = [recorded]
  } else {
    makeOfficeDir(launch.office)
    candidates = mode === "auto" ? order(host) : [mode]
  }
  const notes: string[] = []
  for (const candidate of candidates) {
    let child: fallback.BackgroundChild | undefined
    try {
      if (candidate === "background") child = fallback.startBackground(launch, host)
      else await INSTALL[candidate](launch, host)
    } catch (error) {
      if (!(error instanceof ServiceError) || mode !== "auto" || candidate === candidates.at(-1)) throw error
      notes.push(`${candidate}: ${error.message}`)
      continue
    }
    record(launch, candidate)
    return child === undefined ? { mode: candidate, notes } : { mode: candidate, notes, child }
  }
  throw new Error("unreachable: the last candidate either returns or throws")
}

/**
 * Starts the installed office the way it was installed, falling back to a background process.
 *
 * A fallback is recorded, so the record always names what runs the office. The office dir is made first, since
 * each manager starts the daemon in it.
 *
 * Throws `OfficeStartError` for an office dir that isn't ours, and `ServiceError` if the background fallback
 * can't start the daemon.
 */
export async function start(launch: Launch, host: Host): Promise<Installed> {
  const recorded = recordedMode(launch)
  makeOfficeDir(launch.office)
  const notes: string[] = []
  if (recorded !== null && recorded !== "background") {
    try {
      await START[recorded](launch, host)
      return { mode: recorded, notes: [] }
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error
      notes.push(`${recorded}: ${error.message}`)
    }
  }
  const child = fallback.startBackground(launch, host)
  record(launch, "background")
  return { mode: "background", notes, child }
}

/** How the daemon prefixes the one line it prints when it can't start. */
export const START_ERROR = "opencorp office: "

/**
 * The crash marker's line (`logLine` from the daemon's `crashReport`), capturing `office crashed: <type>`. The type
 * may be empty (an anonymous class); a marker with anything after the type doesn't match, so no message shows.
 */
const CRASH_MARKER = /^\S+ ERROR opencorp\.daemon\.main: (office crashed: \S*)$/

/** The ERROR line a failed `office.start()` logs before its frames, capturing the error's type. */
const FAILED_TO_START = /^\S+ ERROR opencorp\.daemon\.main: the office failed to start: (\S*)$/

/** The start error that follows `FAILED_TO_START` and its frames. */
const SEE_ABOVE = `${START_ERROR}the office failed to start (see the log above)`

/** A duplicate daemon's start error, capturing the pid the pidfile named. */
const ALREADY_RUNNING = /^opencorp office: office already running \(pid (\d+|unknown)\)$/

/** A stack frame line under the crash marker. */
const FRAME = /^\s+at /

/** A line the office wrote to its log (`logLine`): `<ISO time> <level> <logger>: <message>`. */
const OFFICE_LINE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z [A-Z]+ [\w.-]+: /

/** The line Bun ends an uncaught error's report with. */
const BUN_TRAILER = /^Bun v\S+ \(.+\)$/

/** How Bun says it can't load a module, as when the office's checkout moved: shown as is, since it names only the
 *  missing file. */
const MODULE_MISSING = /^error: (?:Module not found "[^"]*"|Cannot find module '[^']*'(?: from '[^']*')?)$/

/** The errno code line of an error Bun printed (`code: "ENOENT"`), the only part of it shown. */
const ERRNO_LINE = /^\s*code: "(E[A-Z0-9]{1,31})",?$/

/** A terminal color code, as Bun colors its error lines. */
const COLOR = /\x1b\[[0-9;]*m/g

/** The most of a foreign line `lastFailure` shows. */
const FOREIGN_CAP = 200

/** The most of the office log `readLog` reads: far more than one start writes. */
const LOG_WINDOW = 64 * 1024

/** How many of the log's lines a failed start shows when nothing in it says why. */
const TAIL_LINES = 20

/**
 * The office log from byte `from` (from the start when the log is shorter, as after a truncation), at most its last
 * `LOG_WINDOW` bytes without the partial first line when that cuts one; line ends are `\n`. Empty when the log
 * isn't a regular file or can't be read. Never follows a symlink, and a FIFO at the path can't hang the open.
 */
export function readLog(file: string, from = 0): string {
  let fd: number
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch {
    return ""
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) return ""
    const begin = from > stat.size ? 0 : from
    const start = Math.max(begin, stat.size - LOG_WINDOW)
    const buf = Buffer.alloc(stat.size - start)
    // Python read the log with universal newlines, so a `\r\n` or lone `\r` ends a line too.
    const text = buf
      .subarray(0, fs.readSync(fd, buf, 0, buf.length, start))
      .toString("utf8")
      .replace(/\r\n?/g, "\n")
    if (start === begin) return text
    const nl = text.indexOf("\n")
    return nl < 0 ? "" : text.slice(nl + 1)
  } catch {
    return ""
  } finally {
    fs.closeSync(fd)
  }
}

/** The non-empty lines of `text`. */
function logLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim())
}

/** The start error at `lines[i]`; `the office failed to start (see the log above)` names the type the ERROR line
 *  above its frames logged instead, since the report shows only this line. */
function startError(lines: string[], i: number): string {
  if (lines[i] !== SEE_ABOVE) return lines[i]!
  let j = i - 1
  while (j >= 0 && FRAME.test(lines[j]!)) j--
  const type = j >= 0 ? lines[j]!.match(FAILED_TO_START)?.[1] : undefined
  return type === undefined ? lines[i]! : `${START_ERROR}the office failed to start: ${type}`
}

/** Why the daemon's last start failed: `text`, and whether the office wrote it (`foreign` when it didn't). */
export interface Failure {
  text: string
  foreign: boolean
}

/**
 * Why the daemon's last start failed, from the office log's text, or null if it didn't: the line it printed when it
 * couldn't start; `office crashed: <type>` when the log ends with the crash marker and its frames (the frames stay in
 * the log); or, when the log ends with output the office didn't write (Bun's own report of an error at load, as when
 * the checkout it ran from moved), a foreign failure. A marker or start error with office lines after it belongs to
 * an earlier start, and a duplicate start (exit 0) is no failure.
 *
 * Of foreign output only Bun's missing-module line and an errno code are shown; anything else may hold anything.
 */
export function lastFailure(text: string): Failure | null {
  const lines = logLines(text.replace(COLOR, ""))
  const last = lines.at(-1)
  if (last === undefined) return null
  if (last.startsWith(START_ERROR)) {
    return ALREADY_RUNNING.test(last) ? null : { text: startError(lines, lines.length - 1), foreign: false }
  }
  const end = lines.findLast((line) => !FRAME.test(line) && !BUN_TRAILER.test(line))
  if (end === undefined) return null
  const marker = end.match(CRASH_MARKER)?.[1]
  if (marker !== undefined) return { text: marker, foreign: false }
  if (OFFICE_LINE.test(end) || end.startsWith(START_ERROR)) return null
  const ours = lines.findLastIndex((line) => OFFICE_LINE.test(line) || line.startsWith(START_ERROR))
  const block = lines.slice(ours + 1)
  const missing = block.find((line) => MODULE_MISSING.test(line))
  if (missing !== undefined) return { text: missing.slice(0, FOREIGN_CAP), foreign: true }
  const code = block.map((line) => line.match(ERRNO_LINE)?.[1]).find((found) => found !== undefined)
  const said = code ? `an ${code} error` : "output"
  return { text: `the log ends with ${said} the office didn't write`, foreign: true }
}

/** Why a background daemon ended before it answered: its start error (with the prefix), the type it crashed with,
 *  the pid of the office already holding the home (null when its pidfile named none), or just how it exited with
 *  the end of what it logged. */
export type StartFailure =
  | { error: string }
  | { crash: string }
  | { running: number | null }
  | { exited: string; tail: string }

/**
 * Why a background daemon that exited with `exit` failed, from `text`, what the log gained after it was spawned. A
 * clean exit (0) is a duplicate start when it said the office already runs. Otherwise the first start error or crash
 * marker in `text` is the reason: a concurrent duplicate exits 0 and only says the office already runs, so its line
 * is never taken for ours.
 */
export function startFailure(text: string, exit: fallback.Exit): StartFailure {
  const lines = logLines(text)
  const tail = lines.slice(-TAIL_LINES).join("\n")
  if (exit.code === 0) {
    for (const line of lines) {
      const held = line.match(ALREADY_RUNNING)?.[1]
      if (held !== undefined) return { running: held === "unknown" ? null : Number(held) }
    }
    return { exited: "exit code 0", tail }
  }
  for (const [i, line] of lines.entries()) {
    if (line.startsWith(START_ERROR) && !ALREADY_RUNNING.test(line)) return { error: startError(lines, i) }
    const crashed = line.match(CRASH_MARKER)?.[1]
    if (crashed !== undefined) return { crash: crashed.slice("office crashed: ".length) }
  }
  const how = exit.error ? "it couldn't be started" : exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`
  return { exited: how, tail }
}

/** An office already holds this home's lock but didn't answer in time: `pid` is what its pidfile named, and
 *  `verified` whether that pid is this office's daemon (its start time and args checked). */
export class LockHeld extends ServiceError {
  override name = "LockHeld"

  constructor(
    /** What happened, without what to do about it. */
    readonly reason: string,
    readonly pid: number | null,
    readonly verified: boolean,
  ) {
    super(`${reason}; \`opencorp doctor\` shows what it is`)
  }
}

/** The error for a background daemon that exited with `failure` before it answered on `launch`'s socket. */
function failedStart(launch: Launch, failure: Exclude<StartFailure, { running: number | null }>): ServiceError {
  if ("error" in failure) {
    return new ServiceError(`the office didn't start: ${failure.error.slice(START_ERROR.length)} (log: ${launch.log})`)
  }
  if ("crash" in failure) {
    return new ServiceError(`the office crashed while starting: ${failure.crash}; its stack is in ${launch.log}`)
  }
  const said = failure.tail
    ? `the end of what it wrote to ${launch.log}:\n${failure.tail}\n`
    : `nothing in ${launch.log}`
  return new ServiceError(`the office exited (${failure.exited}) before it answered on ${launch.socket}; ${said}`)
}

/**
 * Waits up to `timeoutMs` for the office to answer; resolves to whether `child`, the daemon a background start just
 * spawned, is the one answering (`started`) or another office already was (`already-running`).
 *
 * With `child`, the wait ends as soon as it has exited and one more probe gets no answer: a start error or crash in
 * what it logged is thrown at once, and a duplicate that found the home held keeps waiting for the holder until the
 * holder's own start error or crash shows up in the log, or the deadline, then throws `LockHeld`. A start error is
 * read from what the log gained since the spawn, so an older start's is never blamed; a concurrent start that
 * failed first can be. Without one (a managed mode), or when the child is still starting, it waits
 * the full time. Throws `ServiceError` with the log's tail when nothing answered.
 */
export async function wait(
  launch: Launch,
  host: Host,
  timeoutMs = 20_000,
  child?: fallback.BackgroundChild,
  { ps }: { ps?: string } = {},
): Promise<"started" | "already-running"> {
  const deadline = host.clock() + timeoutMs
  let exit: fallback.Exit | undefined
  void child?.exited.then((done) => (exit = done))
  let seenExit = false
  let holder: { running: number | null } | undefined
  for (;;) {
    // Each probe gets only the time left, so an office that accepts but hangs can't stretch the wait.
    let left = deadline - host.clock()
    if (await host.answers(launch.socket, Math.min(2000, Math.max(left, 50)))) return whoAnswered(launch, child, exit)
    if (child !== undefined && exit !== undefined && holder === undefined) {
      // One more probe after the exit was seen: a concurrent start may have just begun answering.
      if (!seenExit) {
        seenExit = true
        continue
      }
      const failure = startFailure(readLog(launch.log, child.logFrom), exit)
      if (!("running" in failure)) throw failedStart(launch, failure)
      holder = failure
    } else if (child !== undefined && holder !== undefined) {
      // The holder was still starting; its own start error or crash, logged since, is why no office will answer.
      const failure = startFailure(readLog(launch.log, child.logFrom), { code: 1, signal: null })
      if ("error" in failure || "crash" in failure) throw failedStart(launch, failure)
    }
    left = deadline - host.clock()
    if (left <= 0) break
    await host.sleep(Math.min(100, left))
  }
  if (holder !== undefined) {
    const pid = holder.running
    // Resolved only here: most waits never need `ps`.
    ps ??= resolveTools(daemonEnv(process.env)).ps
    const verified = pid !== null && fallback.daemon(launch, ps)?.pid === pid
    const reason =
      `an office (pid ${pid ?? "unknown"}) holds the lock on ${launch.home} but hasn't answered on ${launch.socket}` +
      ` within ${timeoutMs / 1000}s (still starting, or hung)`
    throw new LockHeld(reason, pid, verified)
  }
  const tail = logLines(readLog(launch.log)).slice(-TAIL_LINES)
  throw new ServiceError(
    `the office did not answer on ${launch.socket} within ${timeoutMs / 1000}s;` +
      ` the end of ${launch.log}:\n${tail.length ? `${tail.join("\n")}\n` : "(no log)\n"}`,
  )
}

/** Whether the office answering is `child` (`started`) or one that already ran (`already-running`): the pidfile
 *  names the daemon holding the home; without one, a child that has exited can't be it. */
function whoAnswered(
  launch: Launch,
  child: fallback.BackgroundChild | undefined,
  exit: fallback.Exit | undefined,
): "started" | "already-running" {
  if (child === undefined) return "started"
  const holder = fallback.pidOf(launch)
  if (holder !== null) return holder === child.pid ? "started" : "already-running"
  return exit === undefined ? "started" : "already-running"
}

/**
 * Stops the office and removes its service, whatever runs it; resolves to what was done, one line each.
 *
 * Every manager's file is removed, not just the recorded one's: `start` falls back to a background process and
 * records that, leaving the old plist or unit behind. A daemon still holding the pidfile afterwards (one in the
 * background, or started by hand; found by `lookup`, by default `findDaemon`'s) gets SIGTERM, then SIGKILL after
 * `timeoutMs`. The record goes too. Running it again does nothing.
 *
 * Throws `ServiceError` if the office still answers afterwards.
 */
export async function uninstall(
  launch: Launch,
  host: Host,
  timeoutMs = fallback.STOP_TIMEOUT_MS,
  lookup?: Lookup,
): Promise<string[]> {
  lookup ??= await findDaemon(launch, host)
  const recorded = recordedMode(launch)
  const done = [
    await launchd.uninstall(launch, host, recorded === "launchd"),
    await systemd.uninstall(launch, host, recorded === "systemd"),
  ]
  if (recorded === "tmux" || host.which("tmux")) done.push(await fallback.stopTmux(launch, host))
  // The lookup can be from before a manager restarted the daemon; the pidfile then names the new one.
  const stopped =
    (await fallback.stopProcess(launch, { timeoutMs, found: lookup.daemon })) ??
    (await fallback.stopProcess(launch, { timeoutMs }))
  if (stopped) done.push(`${recorded ?? "started by hand"}: ${stopped.line}`)
  fs.rmSync(path.join(launch.office, "install.json"), { force: true })
  await waitStopped(launch, host, lookup, stopped !== null)
  return done.filter((line): line is string => Boolean(line))
}

/** Where `lookup`'s pid came from, as messages name it. */
function source(lookup: Lookup): string {
  return lookup.from === "office" ? "GET /office" : "office.pid"
}

/**
 * Waits up to `timeoutMs` for the office to stop answering; throws `ServiceError` if it still does, saying what
 * `lookup` found and whether its daemon was `signalled`: the pid it stopped, one it couldn't verify or that was gone
 * by then (so it signalled nothing), or none.
 */
async function waitStopped(
  launch: Launch,
  host: Host,
  lookup: Lookup,
  signalled: boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = host.clock() + timeoutMs
  while (await host.answers(launch.socket, 1000)) {
    if (host.clock() >= deadline) {
      throw new ServiceError(`the office still answers on ${launch.socket}${why(lookup, signalled)}`)
    }
    await host.sleep(100)
  }
}

/** Why an office still answers after a stop, from what `lookup` found and whether its daemon was `signalled`. */
function why(lookup: Lookup, signalled: boolean): string {
  const { daemon, named } = lookup
  if (daemon !== null && signalled) {
    return ` after pid ${daemon.pid} was stopped (another daemon took its place?); \`opencorp doctor\` shows what it is`
  }
  if (daemon !== null) {
    return (
      ` (pid ${daemon.pid}, from ${source(lookup)}); it had exited before it could be signalled, so nothing was` +
      " signalled; `opencorp doctor` shows what it is"
    )
  }
  if (named === null) {
    return ", and neither GET /office nor office.pid names its pid; `opencorp doctor` shows what it is"
  }
  if (!lookup.checked && lookup.from === "office") {
    return (
      ` (pid ${named}, from GET /office); this machine has no \`ps\` to check it with; if pid ${named} is the` +
      ` office, \`kill ${named}\` stops it`
    )
  }
  return (
    ` (pid ${named}, from ${source(lookup)}); it isn't one this command could verify as this office's daemon, so` +
    " nothing was signalled; `opencorp doctor` shows what it is"
  )
}

/** What `stop` did: the pid of the office it stopped (`?` when its manager stopped one whose pid it couldn't tell;
 *  null when none ran), and whether it took SIGKILL. */
export interface Stopped {
  stopped: number | "?" | null
  killed: boolean
}

/**
 * Stops the office now and leaves its service installed, as `systemctl stop` does: launchd or systemd starts it
 * again at the next login (or boot), `start` starts it at once, and offboarding removes it.
 *
 * The daemon is the one `lookup` (by default `findDaemon`'s) verified: SIGTERM, then SIGKILL after `timeoutMs`. A
 * daemon exits 0 on SIGTERM, which neither launchd nor systemd restarts; one that took SIGKILL failed, so its manager
 * would start it again. Under systemd the unit is stopped too, which cancels that restart; launchd has no such call
 * short of unloading the service, so the caller says so. A tmux session is killed with its daemon.
 *
 * Throws `ServiceError` if the office still answers afterwards.
 */
export async function stop(
  launch: Launch,
  host: Host,
  timeoutMs = fallback.STOP_TIMEOUT_MS,
  lookup?: Lookup,
): Promise<Stopped> {
  lookup ??= await findDaemon(launch, host)
  const answered = await host.answers(launch.socket)
  const done = await fallback.stopProcess(launch, { timeoutMs, found: lookup.daemon })
  const mode = recordedMode(launch)
  const session = mode === "tmux" ? await fallback.stopTmux(launch, host) : null
  // Best effort: the daemon is usually stopped by now, and a unit systemd doesn't know has nothing to restart.
  if (mode === "systemd") await host.run(["systemctl", "--user", "stop", systemd.unitName(launch)])
  await waitStopped(launch, host, lookup, done !== null)
  if (done !== null) return { stopped: done.pid, killed: done.killed }
  // Its manager stopped an office this command couldn't verify (no `ps`, say).
  const managed = answered || session !== null
  return { stopped: managed ? (lookup.named ?? "?") : null, killed: false }
}

/**
 * Stops the office's daemon and starts it again the way `start` would; a stopped office is just started. The
 * daemon is the one `lookup` (by default `findDaemon`'s) verified; resolves with the pid that was stopped, or null.
 *
 * The daemon gets SIGTERM, then SIGKILL after `timeoutMs`. It exits 0 on SIGTERM, so neither launchd nor systemd
 * restarts it on its own. A leftover tmux session is killed too, since `startTmux` would take it for the running
 * office.
 *
 * Throws `ServiceError` if the office still answers after it was stopped, or it can't be started.
 */
export async function restart(
  launch: Launch,
  host: Host,
  timeoutMs = fallback.STOP_TIMEOUT_MS,
  lookup?: Lookup,
): Promise<Installed & { stopped: number | null }> {
  lookup ??= await findDaemon(launch, host)
  const stopped = await fallback.stopProcess(launch, { timeoutMs, found: lookup.daemon })
  if (recordedMode(launch) === "tmux") await fallback.stopTmux(launch, host)
  await waitStopped(launch, host, lookup, stopped !== null)
  return { ...(await start(launch, host)), stopped: stopped?.pid ?? null }
}

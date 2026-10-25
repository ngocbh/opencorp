/**
 * Installing and starting the office under the best service manager that works here.
 *
 * The mode that worked is recorded in `office/install.json` so the office is started the same way later, and so a
 * running office is never handed to a second manager (two daemons would fight over the pidfile, and launchd or
 * systemd would restart the loser).
 */
import fs from "node:fs"
import path from "node:path"
import { makeOfficeDir } from "../daemon/sockets.ts"
import * as fallback from "./fallback.ts"
import { writeIfChanged } from "./files.ts"
import { type Host, type Launch, ServiceError } from "./launch.ts"
import * as launchd from "./launchd.ts"
import * as systemd from "./systemd.ts"

/** The modes the office runs under, in the order `install` tries them. */
export const MODES = ["launchd", "systemd", "tmux", "background"] as const

/** One of `MODES`. */
export type Mode = (typeof MODES)[number]

/** How long a stop waits after SIGTERM before SIGKILL: the daemon's worst-case stop is about 20 s, and its store
 *  must close cleanly. */
export const STOP_TIMEOUT_MS = 25_000

type Step = (launch: Launch, host: Host) => Promise<void> | void
/** Why the manager doesn't have the office's service, or null if it does. */
type Check = (launch: Launch, host: Host) => Promise<string | null>

const INSTALL: Record<Mode, Step> = {
  launchd: launchd.install,
  systemd: systemd.install,
  tmux: fallback.startTmux,
  background: fallback.startBackground,
}
const START: Record<Mode, Step> = {
  launchd: launchd.start,
  systemd: systemd.start,
  tmux: fallback.startTmux,
  background: fallback.startBackground,
}
const NOT_MANAGED: Partial<Record<Mode, Check>> = {
  launchd: launchd.notLoaded,
  systemd: systemd.notEnabled,
}

/** The mode the office runs under (null if it was already running unmanaged) and why others were skipped. */
export interface Installed {
  mode: Mode | null
  notes: string[]
}

function isMode(value: unknown): value is Mode {
  return (MODES as readonly unknown[]).includes(value)
}

/** The mode `install` last recorded for this office, if any. */
export function recordedMode(launch: Launch): Mode | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(launch.office, "install.json"), "utf8"))
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

/** The pid in the office's pidfile, or `?` if there is none. */
export function pid(launch: Launch): string {
  try {
    return fs.readFileSync(path.join(launch.office, "office.pid"), "utf8").trim() || "?"
  } catch {
    return "?"
  }
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
            " a service; stop it and run `opencorp onboard` again to install one",
        ],
      }
    }
    if (mode !== "auto" && mode !== recorded) {
      throw new ServiceError(`the office is already running under ${recorded}; stop it before moving it to ${mode}`)
    }
    const notManaged = NOT_MANAGED[recorded]
    if (notManaged !== undefined) {
      const problem = await notManaged(launch, host)
      if (problem !== null) {
        throw new ServiceError(
          `the office is running, but ${recorded} doesn't have its service (${problem});` +
            " stop the office and run `opencorp onboard` again",
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
    try {
      await INSTALL[candidate](launch, host)
    } catch (error) {
      if (!(error instanceof ServiceError) || mode !== "auto" || candidate === candidates.at(-1)) throw error
      notes.push(`${candidate}: ${error.message}`)
      continue
    }
    record(launch, candidate)
    return { mode: candidate, notes }
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
  fallback.startBackground(launch, host)
  record(launch, "background")
  return { mode: "background", notes }
}

function tail(file: string, lines = 20): string {
  try {
    // Python read the log with universal newlines, so a `\r\n` or lone `\r` ends a line too.
    const text = fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n")
    return text
      .split(/(?<=\n)/)
      .filter(Boolean)
      .slice(-lines)
      .join("")
  } catch {
    return "(no log)\n"
  }
}

/** Waits up to `timeoutMs` for the office to answer; throws `ServiceError` with the log's tail if it doesn't. */
export async function wait(launch: Launch, host: Host, timeoutMs = 20_000): Promise<void> {
  const deadline = host.clock() + timeoutMs
  for (;;) {
    // Each probe gets only the time left, so an office that accepts but hangs can't stretch the wait.
    let left = deadline - host.clock()
    if (await host.answers(launch.socket, Math.min(2000, Math.max(left, 50)))) return
    left = deadline - host.clock()
    if (left <= 0) break
    await host.sleep(Math.min(100, left))
  }
  throw new ServiceError(
    `the office did not answer on ${launch.socket} within ${timeoutMs / 1000}s;` +
      ` the end of ${launch.log}:\n${tail(launch.log)}`,
  )
}

/**
 * Stops the office and removes its service, whatever runs it; resolves to what was done, one line each.
 *
 * Every manager's file is removed, not just the recorded one's: `start` falls back to a background process and
 * records that, leaving the old plist or unit behind. A daemon still holding the pidfile afterwards (one in the
 * background, or started by hand) gets SIGTERM, then SIGKILL after `timeoutMs`. The record goes too. Running it
 * again does nothing.
 *
 * Throws `ServiceError` if the office still answers afterwards.
 */
export async function uninstall(launch: Launch, host: Host, timeoutMs = STOP_TIMEOUT_MS): Promise<string[]> {
  const recorded = recordedMode(launch)
  const done = [
    await launchd.uninstall(launch, host, recorded === "launchd"),
    await systemd.uninstall(launch, host, recorded === "systemd"),
  ]
  if (recorded === "tmux" || host.which("tmux")) done.push(await fallback.stopTmux(launch, host))
  const stopped = await fallback.stopProcess(launch, { timeoutMs })
  if (stopped) done.push(`${recorded ?? "started by hand"}: ${stopped}`)
  fs.rmSync(path.join(launch.office, "install.json"), { force: true })
  await waitStopped(launch, host)
  return done.filter((line): line is string => Boolean(line))
}

/** Waits up to `timeoutMs` for the office to stop answering; throws `ServiceError` if it still does. */
async function waitStopped(launch: Launch, host: Host, timeoutMs = 5000): Promise<void> {
  const deadline = host.clock() + timeoutMs
  while (await host.answers(launch.socket, 1000)) {
    if (host.clock() >= deadline) {
      throw new ServiceError(
        `the office still answers on ${launch.socket} (pid ${pid(launch)}); stop it and try again`,
      )
    }
    await host.sleep(100)
  }
}

/**
 * Stops the office's daemon and starts it again the way `start` would; a stopped office is just started.
 *
 * The daemon gets SIGTERM, then SIGKILL after `timeoutMs`. It exits 0 on SIGTERM, so neither launchd nor systemd
 * restarts it on its own. A leftover tmux session is killed too, since `startTmux` would take it for the running
 * office.
 *
 * Throws `ServiceError` if the office still answers after it was stopped, or it can't be started.
 */
export async function restart(launch: Launch, host: Host, timeoutMs = STOP_TIMEOUT_MS): Promise<Installed> {
  await fallback.stopProcess(launch, { timeoutMs })
  if (recordedMode(launch) === "tmux") await fallback.stopTmux(launch, host)
  await waitStopped(launch, host)
  return start(launch, host)
}

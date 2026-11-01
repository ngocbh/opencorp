/** The office as a macOS launch agent: a plist in `~/Library/LaunchAgents` loaded with `launchctl`. */
import fs from "node:fs"
import path from "node:path"
import { strerror } from "../sandbox/fs_helper.ts"
import { writeIfChanged } from "./files.ts"
import { type Completed, type Host, type Launch, ServiceError } from "./launch.ts"

/** How many times `launchctl bootstrap` is tried: straight after `bootout` it can fail with EIO while launchd is
 *  still tearing the old job down, and a few short retries cover it. */
export const BOOTSTRAP_TRIES = 3

/** What `launchctl bootstrap` exits with when it keeps failing with EIO, as it does for a `gui/<uid>` domain from
 *  a session outside the GUI login. */
export const EIO = 5

// The line breaks Python's `str.splitlines` splits on.
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/

/** The agent's launchd label, `com.opencorp.<name>`. */
export function label(launch: Launch): string {
  return `com.opencorp.${launch.name}`
}

/** Where the agent's plist goes: `~/Library/LaunchAgents/<label>.plist`. */
export function plistPath(launch: Launch, host: Host): string {
  return path.join(host.userHome, "Library", "LaunchAgents", `${label(launch)}.plist`)
}

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue }

// plistlib refuses these; it rewrites CR as a newline, which would change the value, so CR is refused too. A lone
// surrogate can't be encoded as UTF-8 (Python raises; Buffer.from would put U+FFFD in its place).
const CONTROL = /[\u0000-\u0008\u000b-\u001f]/
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/** `text` escaped for XML as plistlib escapes it; throws `ServiceError` on what plistlib can't write. */
function escape(text: string): string {
  const bad = CONTROL.exec(text) ?? LONE_SURROGATE.exec(text)
  if (bad) {
    const code = bad[0].charCodeAt(0).toString(16).padStart(4, "0")
    const what = CONTROL.test(bad[0]) ? "the control character" : "a lone surrogate"
    throw new ServiceError(`a launchd plist can't hold ${what} U+${code}`)
  }
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

/** `value` as plistlib's XML writer lays it out at `depth` tabs, one line per element. */
function element(value: PlistValue, depth: number, lines: string[]): void {
  const tabs = "\t".repeat(depth)
  if (typeof value === "string") {
    lines.push(`${tabs}<string>${escape(value)}</string>`)
  } else if (typeof value === "boolean") {
    lines.push(`${tabs}<${value}/>`)
  } else if (typeof value === "number") {
    // plistlib writes a float as <real>, which this writer has no need for.
    if (!Number.isInteger(value)) throw new ServiceError(`a launchd plist number must be an integer, not ${value}`)
    lines.push(`${tabs}<integer>${value}</integer>`)
  } else if (Array.isArray(value)) {
    if (!value.length) {
      lines.push(`${tabs}<array/>`)
      return
    }
    lines.push(`${tabs}<array>`)
    for (const item of value) element(item, depth + 1, lines)
    lines.push(`${tabs}</array>`)
  } else {
    // plistlib sorts by code point; UTF-8 bytes order the same way, UTF-16 units don't.
    const keys = Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    if (!keys.length) {
      lines.push(`${tabs}<dict/>`)
      return
    }
    lines.push(`${tabs}<dict>`)
    for (const key of keys) {
      lines.push(`${tabs}\t<key>${escape(key)}</key>`)
      element(value[key]!, depth + 1, lines)
    }
    lines.push(`${tabs}</dict>`)
  }
}

/** `value` as an XML property list, byte for byte what Python's `plistlib.dumps` writes (keys sorted). */
function dumps(value: PlistValue): Buffer {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
  ]
  element(value, 0, lines)
  lines.push("</plist>", "")
  return Buffer.from(lines.join("\n"), "utf8")
}

/**
 * The launch agent: the daemon, restarted only when it fails (at most every 10 s), output appended to the log, with
 * room for 4096 open files, and 30 s to stop before launchd kills it. Throws `ServiceError` if a value holds a
 * control character other than tab and newline, or a lone surrogate.
 */
export function plist(launch: Launch): Buffer {
  return dumps({
    Label: label(launch),
    ProgramArguments: [...launch.argv],
    WorkingDirectory: launch.cwd,
    EnvironmentVariables: { ...launch.env },
    // launchd SIGKILLs a stopping agent after 20 s by default, about the daemon's worst-case stop; 30 s also outlasts
    // the office's own 25 s wait (`fallback.STOP_TIMEOUT_MS`), so launchd doesn't kill a daemon that wait would let
    // finish.
    ExitTimeOut: 30,
    StandardOutPath: launch.log,
    StandardErrorPath: launch.log,
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: 10,
    SoftResourceLimits: { NumberOfFiles: 4096 },
  })
}

/** The `ProgramArguments` array as `plist` lays it out: one tab-indented `<string>` per line. */
const PROGRAM_ARGUMENTS =
  /\n\t<key>ProgramArguments<\/key>\n\t<array>\n((?:\t\t<string>[^<]*<\/string>\n)+)\t<\/array>\n/

/** The program arguments of a plist `plist` wrote (`text`), or null when it isn't laid out as `plist` lays it out. */
export function programArguments(text: string): string[] | null {
  const block = PROGRAM_ARGUMENTS.exec(text)?.[1]
  if (block === undefined) return null
  // `&amp;` last, so an escaped `&lt;` stays text.
  return [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((m) =>
    m[1]!.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"),
  )
}

/** Why launchd doesn't have this office's agent loaded, or null if it does. */
export async function notLoaded(launch: Launch, host: Host): Promise<string | null> {
  const done = await host.run(["launchctl", "print", `gui/${host.uid}/${label(launch)}`])
  return done.code === 0 ? null : done.stderr.trim() || `launchctl print exited ${done.code}`
}

/**
 * Writes the plist and loads it, or kickstarts it if it is already loaded and unchanged.
 *
 * Throws `ServiceError` if the plist can't be made or written, or if `launchctl` is missing or refuses; in the
 * latter case the agent is booted out and its plist removed, so the next login doesn't start a service onboarding
 * gave up on.
 */
export async function install(launch: Launch, host: Host): Promise<void> {
  const file = plistPath(launch, host)
  const domain = `gui/${host.uid}`
  const service = `${domain}/${label(launch)}`
  const probe = await host.run(["launchctl", "print", service])
  if (probe.code === 127) throw new ServiceError(`launchctl: ${probe.stderr.trim()}`)
  const loaded = probe.code === 0
  const data = plist(launch)
  let changed: boolean
  try {
    changed = writeIfChanged(file, data)
  } catch (error) {
    const reason = strerror(error)
    if (reason === undefined) throw error
    throw new ServiceError(`can't write ${file}: ${reason}`)
  }
  if (loaded && !changed) return start(launch, host)
  if (loaded) await host.run(["launchctl", "bootout", service])
  let done!: Completed
  for (let attempt = 0; attempt < BOOTSTRAP_TRIES; attempt++) {
    done = await host.run(["launchctl", "bootstrap", domain, file])
    if (done.code === 0) return
    await host.sleep(500 * (attempt + 1))
  }
  fs.rmSync(file, { force: true })
  const stderr = done.stderr.trim()
  if (done.code === EIO) {
    // launchctl suggests re-running as root, but the agent belongs in the GUI login's session.
    const reason = stderr ? stderr.split(LINE_BREAK)[0] : "Input/output error"
    throw new ServiceError(
      `launchctl bootstrap ${domain} failed: ${reason}; this happens outside a GUI login` +
        " (over SSH or in a detached tmux): run `opencorp onboard` from Terminal in your GUI login," +
        " or pass `--service tmux`",
    )
  }
  throw new ServiceError(`launchctl bootstrap ${domain} failed: ${stderr}`)
}

/**
 * Starts the installed launch agent if it isn't running.
 *
 * Throws `ServiceError` if `launchctl kickstart` refuses; the agent is then booted out and its plist removed, so
 * the next login doesn't start a service the caller moved off.
 */
export async function start(launch: Launch, host: Host): Promise<void> {
  const service = `gui/${host.uid}/${label(launch)}`
  const done = await host.run(["launchctl", "kickstart", service])
  if (done.code !== 0) {
    await host.run(["launchctl", "bootout", service])
    fs.rmSync(plistPath(launch, host), { force: true })
    throw new ServiceError(`launchctl kickstart failed: ${done.stderr.trim()}`)
  }
}

/**
 * Boots the launch agent out and removes its plist; says what was done, or null if there was nothing.
 *
 * With `recorded` (launchd is the recorded mode) the agent is booted out even without its plist, since a loaded
 * agent outlives its file until logout.
 */
export async function uninstall(launch: Launch, host: Host, recorded = false): Promise<string | null> {
  const file = plistPath(launch, host)
  if (!fs.existsSync(file) && !recorded) return null
  // Not loaded (exit 3) or no launchctl at all both leave only the file to remove.
  await host.run(["launchctl", "bootout", `gui/${host.uid}/${label(launch)}`])
  fs.rmSync(file, { force: true })
  return `launchd: booted out ${label(launch)} and removed ${file}`
}

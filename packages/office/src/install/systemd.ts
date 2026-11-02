/** The office as a systemd user service in `~/.config/systemd/user`. */
import fs from "node:fs"
import path from "node:path"
import { strerror } from "../sandbox/fs_helper.ts"
import { writeIfChanged } from "./files.ts"
import { type Host, type Launch, ServiceError } from "./launch.ts"

/** The unit's name, `opencorp-<name>.service`. */
export function unitName(launch: Launch): string {
  return `opencorp-${launch.name}.service`
}

/** Where the unit goes: `~/.config/systemd/user/<unit name>`. */
export function unitPath(launch: Launch, host: Host): string {
  return path.join(host.userHome, ".config", "systemd", "user", unitName(launch))
}

/** `value` for a unit setting: `%` is systemd's specifier prefix, so it is doubled. Throws `RangeError` on a
 *  newline, which would end the setting. */
function plain(value: string): string {
  if (value.includes("\n")) throw new RangeError(`a newline can't go in a systemd unit: ${JSON.stringify(value)}`)
  return value.split("%").join("%%")
}

/** `value` as a double-quoted unit word. */
function quoted(value: string): string {
  return `"${plain(value).split("\\").join("\\\\").split('"').join('\\"')}"`
}

/** One `ExecStart` word: `$` doubled so systemd doesn't expand it, quoted only if needed. */
function arg(value: string): string {
  if (value === "" || [...` \t"'\\;`].some((c) => value.includes(c))) return quoted(value).split("$").join("$$")
  return plain(value).split("$").join("$$")
}

/** The words of the `ExecStart` line of a unit `unit` wrote (`text`), with `arg`'s quoting and doubling undone; null
 *  when there is no such line or a quote isn't closed. */
export function execStart(text: string): string[] | null {
  const line = /^ExecStart=(.*)$/m.exec(text)?.[1]
  if (line === undefined) return null
  const words: string[] = []
  let at = 0
  while (at <= line.length) {
    let word = ""
    if (line[at] === '"') {
      at++
      while (at < line.length && line[at] !== '"') {
        if (line[at] === "\\") at++
        word += line[at] ?? ""
        at++
      }
      if (at >= line.length) return null // no closing quote
      at++
      if (at < line.length && line[at] !== " ") return null
    } else {
      const end = line.indexOf(" ", at)
      word = line.slice(at, end < 0 ? line.length : end)
      at += word.length
    }
    words.push(word.replaceAll("$$", "$").replaceAll("%%", "%"))
    at++ // the space
  }
  return words
}

/**
 * The unit: the daemon, restarted only when it fails, output appended to the log, with room for 4096 open files.
 * Throws `RangeError` if a value holds a newline.
 *
 * The limit is soft only: the hard limit stays the user manager's, since systemd clamps an unprivileged
 * `infinity` to it. A daemon that fails five times in two minutes is left stopped rather than restarted forever.
 */
export function unit(launch: Launch): string {
  const env = Object.keys(launch.env)
    .sort()
    .map((key) => `Environment=${quoted(`${key}=${launch.env[key]}`)}\n`)
    .join("")
  const log = plain(launch.log)
  return (
    "[Unit]\n" +
    `Description=OpenCorp office at ${plain(launch.home)}\n` +
    "StartLimitIntervalSec=120\n" +
    "StartLimitBurst=5\n" +
    "\n" +
    "[Service]\n" +
    "Type=simple\n" +
    "LimitNOFILE=4096:infinity\n" +
    `WorkingDirectory=${plain(launch.cwd)}\n` +
    env +
    `ExecStart=${launch.argv.map(arg).join(" ")}\n` +
    `StandardOutput=append:${log}\n` +
    `StandardError=append:${log}\n` +
    "Restart=on-failure\n" +
    "RestartSec=5\n" +
    "\n" +
    "[Install]\n" +
    "WantedBy=default.target\n"
  )
}

/** Why this office's unit isn't enabled (systemctl's own words), or null if it is. */
export async function notEnabled(launch: Launch, host: Host): Promise<string | null> {
  const done = await host.run(["systemctl", "--user", "is-enabled", unitName(launch)])
  if (done.code === 0) return null
  return done.stderr.trim() || done.stdout.trim() || `systemctl --user is-enabled exited ${done.code}`
}

/**
 * Writes the unit, enables it, and (re)starts it.
 *
 * Throws `ServiceError` if a path can't go in a unit (a newline), if the unit can't be written, or if
 * `systemctl --user` is missing, has no user bus, or refuses; in the last case the unit and its
 * `default.target.wants` link are removed.
 */
export async function install(launch: Launch, host: Host): Promise<void> {
  const file = unitPath(launch, host)
  const name = unitName(launch)
  let text: string
  try {
    text = unit(launch)
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    throw new ServiceError(error.message)
  }
  let changed: boolean
  try {
    changed = writeIfChanged(file, text)
  } catch (error) {
    const reason = strerror(error)
    if (reason === undefined) throw error
    throw new ServiceError(`can't write ${file}: ${reason}`)
  }
  for (const verb of ["daemon-reload", "enable", changed ? "restart" : "start"]) {
    const done = await host.run(["systemctl", "--user", verb, ...(verb === "daemon-reload" ? [] : [name])])
    if (done.code !== 0) {
      remove(launch, host)
      throw new ServiceError(`systemctl --user ${verb} failed: ${done.stderr.trim()}`)
    }
  }
}

/** The unit's `default.target.wants` link, which `systemctl enable` makes. */
function wantsPath(launch: Launch, host: Host): string {
  return path.join(path.dirname(unitPath(launch, host)), "default.target.wants", unitName(launch))
}

/** Removes the unit and its `default.target.wants` link, which disables it without systemctl. */
function remove(launch: Launch, host: Host): void {
  fs.rmSync(unitPath(launch, host), { force: true })
  fs.rmSync(wantsPath(launch, host), { force: true })
}

/**
 * Starts the installed unit if it isn't running.
 *
 * Throws `ServiceError` if `systemctl --user start` refuses; the unit and its `default.target.wants` link are then
 * removed, so the next login doesn't start a service the caller moved off.
 */
export async function start(launch: Launch, host: Host): Promise<void> {
  const done = await host.run(["systemctl", "--user", "start", unitName(launch)])
  if (done.code !== 0) {
    remove(launch, host)
    throw new ServiceError(`systemctl --user start failed: ${done.stderr.trim()}`)
  }
}

/** Whether `file` is a symlink (dangling or not). */
function isSymlink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Disables and stops the unit and removes it; says what was done, or null if there was nothing.
 *
 * With `recorded` (systemd is the recorded mode) the unit is stopped even without its file.
 */
export async function uninstall(launch: Launch, host: Host, recorded = false): Promise<string | null> {
  const file = unitPath(launch, host)
  if (!fs.existsSync(file) && !isSymlink(wantsPath(launch, host)) && !recorded) return null
  await host.run(["systemctl", "--user", "disable", "--now", unitName(launch)])
  remove(launch, host)
  await host.run(["systemctl", "--user", "daemon-reload"])
  return `systemd: disabled and stopped ${unitName(launch)} and removed ${file}`
}

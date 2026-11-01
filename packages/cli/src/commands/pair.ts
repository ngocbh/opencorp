// `opencorp pair`: a one-time link that signs a browser in to this office's HQ. The code is only ever printed or put
// in a 0600 file the office wrote: never in a process's arguments, where other users could read it.
import { isMissingRoute, isNotImplemented, OfficeUnavailable } from "@opencorp/client"
import { opencorpHome } from "@opencorp/client/node"
import { otherPort, SETTINGS_IGNORED } from "@opencorp/office/hq/config"
import type { HqStatus, HqTcp, PairCode } from "@opencorp/protocol"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import type { CommandRun } from "../main"
import { bareHandle, localIdentity, officeClient, officeNotRunning } from "../office"

/**
 * The local port the printed SSH forwards use for hq.sock: any free one works there, since hq.sock takes any port. Not
 * HQ's TCP default (49380), which an office on the browser's machine may hold; a different port also keeps that
 * office's cookie apart from this one's, since the cookie's name carries the port. When HQ's own TCP port is this one,
 * `socketPort` picks the next.
 */
export const LOCAL_PORT = 49381

/**
 * The local port for a forward of hq.sock when HQ's TCP port is `port`: `LOCAL_PORT`, or the next one when HQ's TCP
 * port is `LOCAL_PORT`, since the socket forward is the fallback for when that port is busy and mustn't bind it too.
 */
export const socketPort = (port: number) => (port === LOCAL_PORT ? LOCAL_PORT + 1 : LOCAL_PORT)

type Env = Record<string, string | undefined>

/** Whether this is an SSH session: sshd sets `SSH_CONNECTION` and `SSH_CLIENT`, and `SSH_TTY` with a terminal. */
const overSsh = (env: Env) => !!(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY)

/** Whether `pair` can open a browser here: a Mac or a Linux display, and not over SSH. */
export function canOpen(env: Env, platform: string) {
  if (overSsh(env)) return false
  return platform === "darwin" || !!env.DISPLAY || !!env.WAYLAND_DISPLAY
}

/** `s` as one shell word: as is when it's plainly safe, else single-quoted. */
const shellWord = (s: string) => (/^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`)

/** An SSH command that forwards 127.0.0.1:`port` on the browser's machine to `target` on `host`, or fails loudly. */
const forward = (port: number, target: string, host: string) =>
  `  ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:${port}:${target} ${host}`

/** When `ts` is, as "in the next 5 minutes (until 14:05)": the clock time is this machine's, which may not be yours. */
function expiry(ts: string, now: number) {
  const minutes = Math.max(1, Math.round((Date.parse(ts) - now) / 60_000))
  const clock = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  return `in the next ${minutes} minute${minutes === 1 ? "" : "s"} (until ${clock})`
}

/** HQ's web port as a phrase: "HQ's web port 49380", or without a number for `port: 0` (any free one). */
const webPort = (port: number) => (port ? `HQ's web port ${port}` : "HQ's web port")

const APP_MISSING = "HQ's web app isn't built, so the link won't load yet; `opencorp doctor` says why."
const NO_SOCKET = "(HQ's socket isn't listening here, so there's no fallback through it; `opencorp doctor` says why.)"

/** How to turn TCP on in `hqJson`: fix the file when GET /hq's `warnings` say it was ignored, else add the key. */
const tcpOn = (hqJson: string, warnings: readonly string[]) =>
  warnings.some((w) => w.startsWith(SETTINGS_IGNORED))
    ? `fix ${shellWord(hqJson)} so it has "tcp": true`
    : `add "tcp": true to ${shellWord(hqJson)}`

/** How to move HQ's web port off `port`, which another program holds, by setting another in `hqJson`. */
const otherPortHint = (port: number, hqJson: string) => [
  `If another program holds port ${port}, set "port" in ${shellWord(hqJson)} to a free one, for ` +
    `example {"port": ${otherPort(port)}}, or 0 for any free port (its URL then changes with each restart).`,
  // On Linux the file holds "tcp": true, so replacing it would turn the web port off.
  "Create the file if it doesn't exist; keep any keys it already has. Then run `opencorp restart`.",
]

/**
 * Why HQ can't be reached at all: hq.sock isn't listening (`socketError`) and neither is its web port (`tcp`, or null
 * when it stopped listening after HQ's status was read), with GET /hq's `warnings` and how to fix it.
 */
function unreachable(socketError: string, tcp: HqTcp | null, warnings: readonly string[], hqJson: string): string[] {
  const state = !tcp
    ? "HQ's web port stopped listening just now"
    : !tcp.enabled
      ? "HQ's web port is off"
      : tcp.error
        ? `${webPort(tcp.port)} isn't listening (${tcp.error})`
        : `${webPort(tcp.port)} isn't listening yet`
  const lines = [`opencorp pair: HQ can't be reached: hq.sock isn't listening (${socketError}), and ${state}.`]
  // With hq.sock down, the web port is the only way in, over SSH too (by forwarding it).
  if (tcp && !tcp.enabled) {
    lines.push(...warnings.map((w) => `  ${w}`))
    lines.push(`To reach it over TCP, ${tcpOn(hqJson, warnings)}, then run \`opencorp restart\`.`)
  } else if (tcp?.error && tcp.port) lines.push(...otherPortHint(tcp.port, hqJson))
  else if (!tcp || !tcp.error) lines.push("Run `opencorp pair` again once the web port is listening.")
  lines.push("`opencorp doctor` says more; run `opencorp restart` once that's fixed.")
  return lines
}

/**
 * What `pair` prints for `code`, and the redirect file to open, if it should open one. `status` is HQ's (`GET /hq`),
 * or null when it couldn't be read; a field an older office doesn't send counts as unknown.
 *
 * With TCP off because hq.json was ignored, the fix is to repair the file, not to add `"tcp": true` to it.
 */
export function pairOutput(
  code: PairCode,
  o: {
    env: Env
    platform: string
    host: string
    noOpen: boolean
    hqJson: string
    status: HqStatus | null
    now?: number
  },
): { lines: string[]; open?: string } {
  const tcp = o.status?.tcp ?? null
  const socketError = o.status?.socket_error ?? null
  const appMissing = o.status?.health?.app === null
  const warnings = o.status?.warnings ?? []
  const lines = [`This link signs a browser in once, ${expiry(code.expires_at, o.now ?? Date.now())}.`]
  if (appMissing) lines.push(APP_MISSING)
  const ssh = overSsh(o.env)
  const local = socketPort(code.port)
  if (code.url && !ssh) {
    const open =
      !o.noOpen && !appMissing && canOpen(o.env, o.platform) && code.open_file ? code.open_file : undefined
    lines.push(open ? "Opening it in your browser. If the page doesn't open or load, use:" : "Open it in your browser:")
    lines.push(`  ${code.url}`)
    return { lines, open }
  }
  if (code.url) {
    // The Host check takes only the listener's own port, so the forward must keep it.
    lines.push(
      "On the machine with your browser, forward HQ's port:",
      forward(code.port, `127.0.0.1:${code.port}`, o.host),
      "then open:",
      `  ${code.url}`,
    )
    if (socketError) lines.push(NO_SOCKET)
    else
      lines.push(
        `If port ${code.port} is in use on your machine (an office runs there), forward HQ's socket instead:`,
        forward(local, shellWord(code.socket), o.host),
        "then open:",
        `  http://127.0.0.1:${local}${code.path}`,
      )
  } else {
    if (!tcp) lines.push("Couldn't read the web port's status.")
    else if (!tcp.enabled) lines.push("HQ's web port is off here.", ...warnings.map((w) => `  ${w}`))
    else if (tcp.error)
      lines.push(`${webPort(tcp.port)} isn't listening (${tcp.error}); \`opencorp doctor\` says more.`)
    else lines.push(`${webPort(tcp.port)} isn't listening yet.`)
    // Here, another port is the fix; port 0 is never taken, so its error is a server that ended.
    if (!ssh && tcp?.enabled && tcp.error && tcp.port) lines.push(...otherPortHint(tcp.port, o.hqJson))
    lines.push(
      "On the machine with your browser, forward HQ's socket:",
      forward(local, shellWord(code.socket), o.host),
      "then open:",
      `  http://127.0.0.1:${local}${code.path}`,
      `(hq.sock takes any port, so any free local port works in place of ${local}.)`,
    )
    if (!ssh && tcp && !tcp.enabled)
      lines.push(`To open it here instead, ${tcpOn(o.hqJson, warnings)}, then run \`opencorp restart\`.`)
  }
  lines.push(`(In place of ${o.host}, use however you reach this machine.)`)
  return { lines }
}

const USAGE = "usage: opencorp pair [--handle HANDLE] [--no-open]"

/** What `pair` reads from and does to the machine; tests pass fakes. */
export type PairDeps = {
  env: Env
  platform: string
  hostname(): string
  /** Starts `argv` without waiting for it, its output discarded; throws if it can't start. */
  spawn(argv: string[]): void
  print(line: string): void
  error(line: string): void
}

export const realPairDeps: PairDeps = {
  env: process.env,
  platform: process.platform,
  hostname: () => os.hostname(),
  spawn: (argv) => void Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"] }).unref(),
  print: (line) => console.log(line),
  error: (line) => console.error(line),
}

/** `opencorp pair [--handle H] [--no-open]`: a one-time link that signs a browser in as H (you by default). */
export async function pair(argv: string[], deps: PairDeps = realPairDeps): Promise<number> {
  let values: { handle?: string; "no-open"?: boolean; help?: boolean }
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: { handle: { type: "string" }, "no-open": { type: "boolean" }, help: { type: "boolean", short: "h" } },
    }))
  } catch (e) {
    deps.error(`opencorp pair: ${e instanceof Error ? e.message : e}\n${USAGE}`)
    return 2
  }
  if (values.help) {
    deps.print(USAGE)
    return 0
  }
  const noOpen = !!values["no-open"]
  try {
    const office = officeClient(localIdentity())
    const hqJson = path.join(opencorpHome(), "office", "hq.json")
    // Read before minting, so no code is made when HQ can't be reached. Unreadable (an older office, say): as before.
    const status = await office.hq.status().catch(() => null)
    const tcp = status?.tcp
    const socketError = status?.socket_error ?? null
    if (socketError && tcp?.listening === false) {
      for (const line of unreachable(socketError, tcp, status?.warnings ?? [], hqJson)) deps.error(line)
      return 1
    }
    // A redirect file only when it will be opened: otherwise it would sit in the office dir until it expires. A link
    // to an app that isn't built won't load, so it isn't opened.
    const code = await office.hq.pair({
      handle: values.handle === undefined ? null : bareHandle(values.handle),
      open_file: !noOpen && canOpen(deps.env, deps.platform) && status?.health?.app !== null,
    })
    if (!code.url && socketError) {
      // The web port stopped listening after the read. The code isn't shown, has no file and expires unused.
      for (const line of unreachable(socketError, null, [], hqJson)) deps.error(line)
      return 1
    }
    const out = pairOutput(code, {
      env: deps.env,
      platform: deps.platform,
      host: deps.hostname(),
      noOpen,
      hqJson,
      status,
    })
    for (const line of out.lines) deps.print(line)
    if (out.open) {
      const opener = deps.platform === "darwin" ? "open" : "xdg-open"
      try {
        // argv holds only the file's path; the file (0600, in the office dir) holds the code.
        deps.spawn([opener, out.open])
      } catch (e) {
        // The link is printed already, so it still works by hand.
        deps.error(`Couldn't start ${opener} (${e instanceof Error ? e.message : e}); open the link above.`)
      }
    }
    return 0
  } catch (e) {
    if (e instanceof OfficeUnavailable) return officeNotRunning(e, deps.error)
    if (isMissingRoute(e) || isNotImplemented(e))
      deps.error("opencorp pair: this office has no HQ yet; update the checkout and run `opencorp restart`")
    else deps.error(`opencorp pair: ${e instanceof Error ? e.message : e}`)
    return 1
  }
}

export const run: CommandRun = (argv) => pair(argv)

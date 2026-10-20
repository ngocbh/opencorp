// `opencorp pair`: a one-time link that signs a browser in to this office's HQ. The code is only ever printed or put
// in a 0600 file the office wrote: never in a process's arguments, where other users could read it.
import { isMissingRoute, isNotImplemented, OfficeUnavailable } from "@opencorp/client"
import { opencorpHome } from "@opencorp/client/node"
import type { HqTcp, PairCode } from "@opencorp/protocol"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import type { CommandRun } from "../main"
import { localIdentity, NO_OFFICE, officeClient } from "../office"

/**
 * The local port the printed SSH forwards use for hq.sock: any free one works there, since hq.sock takes any port. Not
 * HQ's TCP default (49380), which an office on the browser's machine may hold; a different port also keeps that
 * office's cookie apart from this one's, since the cookie's name carries the port.
 */
export const LOCAL_PORT = 49381

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

/**
 * What `pair` prints for `code`, and the redirect file to open, if it should open one. `tcp` is HQ's TCP status when
 * there's no URL, or null when it couldn't be read.
 */
export function pairOutput(
  code: PairCode,
  o: { env: Env; platform: string; host: string; noOpen: boolean; hqJson: string; tcp: HqTcp | null; now?: number },
): { lines: string[]; open?: string } {
  const lines = [`This link signs a browser in once, ${expiry(code.expires_at, o.now ?? Date.now())}.`]
  const ssh = overSsh(o.env)
  if (code.url && !ssh) {
    const open = !o.noOpen && canOpen(o.env, o.platform) && code.open_file ? code.open_file : undefined
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
      `If port ${code.port} is in use on your machine (an office runs there), forward HQ's socket instead:`,
      forward(LOCAL_PORT, shellWord(code.socket), o.host),
      "then open:",
      `  http://127.0.0.1:${LOCAL_PORT}${code.path}`,
    )
  } else {
    if (!o.tcp) lines.push("Couldn't read the web port's status.")
    else if (!o.tcp.enabled) lines.push("HQ's web port is off here.")
    else if (o.tcp.error)
      lines.push(`${webPort(o.tcp.port)} isn't listening (${o.tcp.error}); \`opencorp doctor\` says more.`)
    else lines.push(`${webPort(o.tcp.port)} isn't listening yet.`)
    lines.push(
      "On the machine with your browser, forward HQ's socket:",
      forward(LOCAL_PORT, shellWord(code.socket), o.host),
      "then open:",
      `  http://127.0.0.1:${LOCAL_PORT}${code.path}`,
      `(hq.sock takes any port, so any free local port works in place of ${LOCAL_PORT}.)`,
    )
    if (!ssh && o.tcp && !o.tcp.enabled)
      lines.push(`To open it here instead, add "tcp": true to ${shellWord(o.hqJson)}, then run \`opencorp restart\`.`)
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
  let values: { handle?: string; "no-open"?: boolean }
  try {
    ;({ values } = parseArgs({ args: argv, options: { handle: { type: "string" }, "no-open": { type: "boolean" } } }))
  } catch (e) {
    deps.error(`opencorp pair: ${e instanceof Error ? e.message : e}\n${USAGE}`)
    return 2
  }
  const noOpen = !!values["no-open"]
  try {
    const office = officeClient(localIdentity())
    // A redirect file only when it will be opened: otherwise it would sit in the office dir until it expires.
    const code = await office.hq.pair({
      handle: values.handle ?? null,
      open_file: !noOpen && canOpen(deps.env, deps.platform),
    })
    // Without a URL, why matters: TCP off (say how to turn it on) or its port taken (say so, and point at doctor).
    const tcp = code.url ? null : await office.hq.status().then((st) => st.tcp, () => null)
    const out = pairOutput(code, {
      env: deps.env,
      platform: deps.platform,
      host: deps.hostname(),
      noOpen,
      hqJson: path.join(opencorpHome(), "office", "hq.json"),
      tcp,
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
    if (e instanceof OfficeUnavailable) {
      deps.error("The office isn't running. Run `opencorp doctor`.")
      return NO_OFFICE
    }
    if (isMissingRoute(e) || isNotImplemented(e))
      deps.error("opencorp pair: this office has no HQ yet; update the checkout and run `opencorp restart`")
    else deps.error(`opencorp pair: ${e instanceof Error ? e.message : e}`)
    return 1
  }
}

export const run: CommandRun = (argv) => pair(argv)

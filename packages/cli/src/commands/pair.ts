// `opencorp pair`: a one-time link that signs a browser in to this office's HQ. The code is only ever printed or put
// in a 0600 file the office wrote: never in a process's arguments, where other users could read it.
import { isMissingRoute, OfficeUnavailable } from "@opencorp/client"
import { opencorpHome } from "@opencorp/client/node"
import type { HqTcp, PairCode } from "@opencorp/protocol"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import type { CommandRun } from "../main"
import { localIdentity, officeClient, officeNotRunning } from "../office"

/**
 * The local port the printed SSH forwards use for hq.sock: any free one works there, since hq.sock takes any port. Not
 * HQ's TCP default (49380), which an office on the browser's machine may hold; a different port also keeps that
 * office's cookie apart from this one's, since the cookie's name carries the port.
 */
export const LOCAL_PORT = 49381

type Env = Record<string, string | undefined>

/** Whether `pair` can open a browser here: a Mac or a Linux display, and not over SSH. */
export function canOpen(env: Env, platform: string) {
  if (env.SSH_CONNECTION) return false
  return platform === "darwin" || !!env.DISPLAY || !!env.WAYLAND_DISPLAY
}

/** `s` as one shell word: as is when it's plainly safe, else single-quoted. */
const shellWord = (s: string) => (/^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`)

/** An SSH command that forwards 127.0.0.1:`port` on the browser's machine to `target` on `host`, or fails loudly. */
const forward = (port: number, target: string, host: string) =>
  `  ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:${port}:${target} ${host}`

/** `ts` as a local clock time, for "until 14:05". */
const clock = (ts: string) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

/**
 * What `pair` prints for `code`, and the redirect file to open, if it should open one. `tcp` is HQ's TCP status when
 * there's no URL, or null when it couldn't be read.
 */
export function pairOutput(
  code: PairCode,
  o: { env: Env; platform: string; host: string; noOpen: boolean; hqJson: string; tcp: HqTcp | null },
): { lines: string[]; open?: string } {
  const lines = [`This link signs a browser in once, until ${clock(code.expires_at)}.`]
  const overSsh = !!o.env.SSH_CONNECTION
  if (code.url && !overSsh) {
    const open = !o.noOpen && canOpen(o.env, o.platform) && code.open_file ? code.open_file : undefined
    lines.push(open ? "Opening it in your browser. If nothing opens, use:" : "Open it in your browser:")
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
    else {
      const why = o.tcp.error ?? "not listening yet"
      lines.push(`HQ's web port ${o.tcp.port} is taken (${why}); \`opencorp doctor\` says more.`)
    }
    lines.push(
      "On the machine with your browser, forward HQ's socket:",
      forward(LOCAL_PORT, shellWord(code.socket), o.host),
      "then open:",
      `  http://127.0.0.1:${LOCAL_PORT}${code.path}`,
      `(hq.sock takes any port, so any free local port works in place of ${LOCAL_PORT}.)`,
    )
    if (!overSsh && o.tcp && !o.tcp.enabled)
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
  /** Starts `argv` without waiting for it, its output discarded. */
  spawn(argv: string[]): void
  print(line: string): void
}

export const realPairDeps: PairDeps = {
  env: process.env,
  platform: process.platform,
  hostname: () => os.hostname(),
  spawn: (argv) => void Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"] }).unref(),
  print: (line) => console.log(line),
}

/** `opencorp pair [--handle H] [--no-open]`: a one-time link that signs a browser in as H (you by default). */
export async function pair(argv: string[], deps: PairDeps = realPairDeps): Promise<number> {
  let values: { handle?: string; "no-open"?: boolean }
  try {
    ;({ values } = parseArgs({ args: argv, options: { handle: { type: "string" }, "no-open": { type: "boolean" } } }))
  } catch (e) {
    console.error(`opencorp pair: ${e instanceof Error ? e.message : e}\n${USAGE}`)
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
    // argv holds only the file's path; the file (0600, in the office dir) holds the code.
    if (out.open) deps.spawn([deps.platform === "darwin" ? "open" : "xdg-open", out.open])
    return 0
  } catch (e) {
    if (e instanceof OfficeUnavailable) return officeNotRunning()
    if (isMissingRoute(e))
      console.error("opencorp pair: this office has no HQ yet; update the checkout and run `opencorp restart`")
    else console.error(`opencorp pair: ${e instanceof Error ? e.message : e}`)
    return 1
  }
}

export const run: CommandRun = (argv) => pair(argv)

// `opencorp pair`: a one-time link that signs a browser in to this office's HQ. The code is only ever printed or put
// in a 0600 file the office wrote: never in a process's arguments, where other users could read it.
import type { HqTcp, PairCode } from "@opencorp/protocol"

/** The local port the printed SSH forwards use for hq.sock: any free one works there, since hq.sock takes any port. */
export const LOCAL_PORT = 49380

type Env = Record<string, string | undefined>

/** Whether `pair` can open a browser here: a Mac or a Linux display, and not over SSH. */
export function canOpen(env: Env, platform: string) {
  if (env.SSH_CONNECTION) return false
  return platform === "darwin" || !!env.DISPLAY || !!env.WAYLAND_DISPLAY
}

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
      `  ssh -N -L ${code.port}:127.0.0.1:${code.port} ${o.host}`,
      "then open:",
      `  ${code.url}`,
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
      `  ssh -N -L ${LOCAL_PORT}:${code.socket} ${o.host}`,
      "then open:",
      `  http://127.0.0.1:${LOCAL_PORT}${code.path}`,
      `(hq.sock takes any port, so any free local port works in place of ${LOCAL_PORT},` +
        " which is taken where an office runs.)",
    )
    if (!overSsh && o.tcp && !o.tcp.enabled)
      lines.push(`To open it here instead, add "tcp": true to ${o.hqJson}, then run \`opencorp restart\`.`)
  }
  lines.push(`(In place of ${o.host}, use however you reach this machine.)`)
  return { lines }
}

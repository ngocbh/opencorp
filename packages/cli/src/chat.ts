// A built-in agent's chat on the no-office host, with the TUI on it in this process: `opencorp hq`'s learning, and
// init's interview in the install child. This file imports only types, and the install child loads it for every setup
// command: the host and the TUI load only once a chat starts.
import type { OfficeHooks } from "@opencorp/office"
import type { ChatEnd, LocalSession } from "@opencorp/office/server/local"

/** Whether the TUI can draw here: stdin and stdout are terminals, and TERM names one that moves the cursor. */
export function drawable(env: Record<string, string | undefined>, stdinTTY: boolean, stdoutTTY: boolean) {
  return stdinTTY && stdoutTTY && !!env.TERM && env.TERM !== "dumb"
}

/** Whether this process's terminal can draw the TUI (`drawable` on its env, stdin and stdout). */
export const terminal = () => drawable(process.env, Boolean(process.stdin.isTTY), Boolean(process.stdout.isTTY))

/** The value of the last `--home X` or `--home=X` in `argv`, as the install takes it. */
export function homeFlag(argv: string[]): string | undefined {
  let home: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--home" && i + 1 < argv.length) home = argv[++i]
    else if (argv[i].startsWith("--home=")) home = argv[i].slice("--home=".length)
  }
  return home
}

/** Runs `show` with this process's `$OPENCORP_HOME` as `home` (unset when undefined), then puts back the value it had.
 *  The TUI reads its home from there, not from the env a command was given. */
export async function withTuiHome<T>(home: string | undefined, show: () => Promise<T>): Promise<T> {
  const caller = process.env.OPENCORP_HOME
  const set = (value: string | undefined) => {
    if (value === undefined) delete process.env.OPENCORP_HOME
    else process.env.OPENCORP_HOME = value
  }
  set(home)
  try {
    return await show()
  } finally {
    set(caller)
  }
}

/** A built-in agent's chat: its session on the no-office host in this process, served on a private socket to the TUI,
 *  which opens on it and closes once the session is over; the host stops once both are. Resolves to how the session
 *  ended, with why when its run failed, or `left` when the owner left the TUI first, which ends it. The TUI keeps its
 *  state under the office home `home` (a path as `$OPENCORP_HOME` takes one) when given, else `$OPENCORP_HOME`'s. */
export async function localChat(session: LocalSession, home?: string): Promise<ChatEnd> {
  const { LocalHost, OWNER, serveLocal } = await import("@opencorp/office/server/local")
  // In the binary, OpenTUI loads its native library and assets from the install, never from a caller's
  // OTUI_ASSET_ROOT, as main.ts has it for a command: the install child runs no command. A checkout loads them from
  // node_modules.
  const assets = (await import("@opencorp/office/platform")).tuiAssetRoot()
  if (assets !== null) process.env.OTUI_ASSET_ROOT = assets
  // Its workers start from this process's environment, as the office's start from the daemon's.
  const host = await LocalHost.start(session, { environ: process.env })
  let served: Awaited<ReturnType<typeof serveLocal>> | undefined
  try {
    served = await serveLocal(host)
    let over = false
    const until = host.ended.then(() => {
      over = true
      return undefined
    })
    // The TUI is Solid JSX, loaded as `opencorp` loads it.
    const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin")
    ensureSolidTransformPlugin()
    const [{ Effect }, { Global, run: runTui }] = await Promise.all([import("effect"), import("@opencorp/tui")])
    const local = { sessionID: host.id, until }
    const input = { socket: served.socket, token: served.token, person: OWNER, cwd: process.cwd(), args: {}, local }
    // The TUI keeps its state under `home`, as the office's TUI that opens after init does. `$OPENCORP_HOME` is put back
    // once the TUI closes: the install reads it after, to say whether the caller's shell finds this office.
    const show = () => Effect.runPromise(runTui(input).pipe(Effect.provide(Global.layer)))
    await (home === undefined ? show() : withTuiHome(home, show))
    if (!over) return { status: "left", error: null }
    const failure = host.failure
    return failure === null ? { status: "ended", error: null } : { status: "failed", error: failure }
  } finally {
    await host.close()
    await served?.close()
  }
}

/** The hooks the CLI's entry hands `opencorp install`: where the TUI can draw (`drawn`, by default `terminal`, read in
 *  the install child, whose stdio are this terminal's), `chat` runs init's interview on it, its TUI's state under the
 *  install's `--home` (in `argv`, by default this process's arguments) when it has one. */
export function installHooks(drawn: () => boolean = terminal, argv: string[] = process.argv.slice(2)): OfficeHooks {
  if (!drawn()) return {}
  const home = homeFlag(argv)
  return { chat: home ? (session) => localChat(session, home) : localChat }
}

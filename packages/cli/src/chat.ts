// A built-in agent's chat on the no-office host, with the TUI on it in this process: `opencorp hq`'s learning, and
// init's interview in the install child. This file imports only types, and the install child loads it for every setup
// command: the host and the TUI load only once a chat starts.
import type { OfficeHooks } from "@opencorp/office"
import type { ChatEnd, LocalSession } from "@opencorp/office/server/local"

/** Whether the TUI can draw here: stdin and stdout are terminals, and TERM names one that moves the cursor. */
export function drawable(env: Record<string, string | undefined>, stdinTTY: boolean, stdoutTTY: boolean) {
  return stdinTTY && stdoutTTY && !!env.TERM && env.TERM !== "dumb"
}

/** Whether this process's terminal can draw the setup screen or the TUI (`drawable` on its env, stdin and stdout). */
export const terminal = () => drawable(process.env, Boolean(process.stdin.isTTY), Boolean(process.stdout.isTTY))

/** A built-in agent's chat: its session on the no-office host in this process, served on a private socket to the TUI,
 *  which opens on it and closes once the session is over; the host stops once both are. Resolves to how the session
 *  ended, with why when its run failed, or `left` when the owner left the TUI first, which ends it. */
export async function localChat(session: LocalSession): Promise<ChatEnd> {
  const { LocalHost, OWNER, serveLocal } = await import("@opencorp/office/server/local")
  // OpenTUI loads its native library and assets from the install, as main.ts has it load them for a command: the
  // install child runs no command, and a caller's OTUI_ASSET_ROOT is never taken.
  const assets = (await import("@opencorp/office/platform")).tuiAssetRoot()
  if (assets !== null) process.env.OTUI_ASSET_ROOT = assets
  const host = await LocalHost.start(session)
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
    await Effect.runPromise(runTui(input).pipe(Effect.provide(Global.layer)))
    if (!over) return { status: "left", error: null }
    const failure = host.failure
    return failure === null ? { status: "ended", error: null } : { status: "failed", error: failure }
  } finally {
    await host.close()
    await served?.close()
  }
}

/** The hooks the CLI's entry hands `opencorp install`: where the TUI can draw (`drawn`, by default `terminal`, read in
 *  the install child, whose stdio are this terminal's), `chat` runs init's interview on it. */
export function installHooks(drawn: () => boolean = terminal): OfficeHooks {
  return drawn() ? { chat: localChat } : {}
}

import { parseArgs } from "node:util"
import { createOfficeClient, UnknownDevice } from "@opencorp/client"
import { defaultSocket } from "@opencorp/client/node"
import type { CommandRun } from "../main"
import { localIdentity, officeAnswers, officeNotRunning } from "../office"

/** What `opencorp tui --help` prints; `opencorp --help` repeats the option lines. */
export const TUI_USAGE = [
  "usage: opencorp [tui] [-s ID] [-c] [--person HANDLE] [--prompt TEXT]",
  "  -s, --session ID   resume a session",
  "  -c, --continue     continue the last session in this folder",
  "  --person HANDLE    talk to this person",
  "  --prompt TEXT      send TEXT as the first message",
].join("\n")

/** The TUI's args from `opencorp`'s flags: `-s/--session ID`, `-c/--continue`, `--person HANDLE`, `--prompt TEXT`;
 *  `help` when `-h/--help` asks for the usage instead. */
export function parseTuiArgs(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: "string", short: "s" },
      continue: { type: "boolean", short: "c" },
      person: { type: "string" },
      prompt: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  })
  return {
    ...(values.help && { help: true }),
    ...(values.session !== undefined && { sessionID: values.session }),
    ...(values.continue && { continue: true }),
    ...(values.person !== undefined && { person: values.person }),
    ...(values.prompt !== undefined && { prompt: values.prompt }),
  }
}

export const run: CommandRun = async (argv) => {
  let parsed
  try {
    parsed = parseTuiArgs(argv)
  } catch (e) {
    console.error(`opencorp: ${e instanceof Error ? e.message : e}`)
    return 2
  }
  const { help, ...args } = parsed
  if (help) {
    console.log(TUI_USAGE)
    return 0
  }
  const socket = defaultSocket()
  // Asked before the TUI loads, so no office is one line, not a TUI waiting on the socket.
  if (!(await officeAnswers(socket))) return officeNotRunning()
  const token = localIdentity()?.token
  // Likewise a device the office refuses: one line, not a TUI that can't load anything.
  try {
    await createOfficeClient({ socket, token }).whoami()
  } catch (e) {
    // Any other failure, the TUI shows as it would have without this check.
    if (e instanceof UnknownDevice) {
      console.error(`opencorp: ${e.message}`)
      return 1
    }
  }
  // The TUI is Solid JSX: the transform must be registered before its modules load, and a
  // bunfig preload would only apply when `opencorp` runs from this package's folder.
  const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin")
  ensureSolidTransformPlugin()
  const [{ Effect }, { Global, run: runTui }] = await Promise.all([
    import("effect"),
    import("@opencorp/tui"),
  ])
  await Effect.runPromise(
    runTui({ socket, token, cwd: process.cwd(), args }).pipe(Effect.provide(Global.layer)),
  )
  return typeof process.exitCode === "number" ? process.exitCode : 0
}

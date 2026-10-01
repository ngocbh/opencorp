import { parseArgs } from "node:util"
import { createOfficeClient } from "@agent-corp/tui/office/client"
import { UnknownDevice } from "@agent-corp/tui/office/errors"
import { defaultSocket } from "@agent-corp/tui/office/paths"
import type { CommandRun } from "../main"
import { localIdentity, officeAnswers, officeNotRunning } from "../office"

/** The TUI's args from `ac`'s flags: `-s/--session ID`, `-c/--continue`, `--person HANDLE`, `--prompt TEXT`. */
export function parseTuiArgs(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: "string", short: "s" },
      continue: { type: "boolean", short: "c" },
      person: { type: "string" },
      prompt: { type: "string" },
    },
  })
  return {
    ...(values.session !== undefined && { sessionID: values.session }),
    ...(values.continue && { continue: true }),
    ...(values.person !== undefined && { person: values.person }),
    ...(values.prompt !== undefined && { prompt: values.prompt }),
  }
}

export const run: CommandRun = async (argv) => {
  let args
  try {
    args = parseTuiArgs(argv)
  } catch (e) {
    console.error(`ac: ${e instanceof Error ? e.message : e}`)
    return 2
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
      console.error(`ac: ${e.message}`)
      return 1
    }
  }
  // The TUI is Solid JSX: the transform must be registered before its modules load, and a
  // bunfig preload would only apply when `ac` runs from this package's folder.
  const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin")
  ensureSolidTransformPlugin()
  const [{ Effect }, { Global, run: runTui }] = await Promise.all([
    import("effect"),
    import("@agent-corp/tui"),
  ])
  await Effect.runPromise(
    runTui({ socket, token, cwd: process.cwd(), args }).pipe(Effect.provide(Global.layer)),
  )
  return typeof process.exitCode === "number" ? process.exitCode : 0
}

import { parseArgs } from "node:util"
import type { CommandRun } from "../main"

/** The TUI's args from `ac`'s flags: `-s/--session ID`, `-c/--continue`, `--person ID`, `--prompt TEXT`. */
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
  // The TUI is Solid JSX: the transform must be registered before its modules load, and a
  // bunfig preload would only apply when `ac` runs from this package's folder.
  const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin")
  ensureSolidTransformPlugin()
  const [{ Effect }, { Global, defaultSocket, run: runTui }] = await Promise.all([
    import("effect"),
    import("@agent-corp/tui"),
  ])
  await Effect.runPromise(
    runTui({ socket: defaultSocket(), cwd: process.cwd(), args }).pipe(Effect.provide(Global.layer)),
  )
  return typeof process.exitCode === "number" ? process.exitCode : 0
}

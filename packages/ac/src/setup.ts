// `ac init` and `ac onboard`: the install asks its questions on the TUI's setup screen, and the
// office opens once it's done. Without a terminal to draw on, the install runs as it always did.
import { type Deps, realDeps, syncThenInstall, syncVenv, venvPython } from "./office"

/** What setting up touches beyond running the Python side; tests pass fakes. */
export interface SetupDeps extends Deps {
  /** Whether there is a terminal the setup screen can draw on. */
  terminal(): boolean
  /** Runs the install `argv` behind the setup screen; resolves to its exit code once the screen is gone. */
  screen(argv: string[]): Promise<number>
  /** Opens the office as `ac` with no arguments does; resolves to its exit code. */
  openOffice(): Promise<number>
}

/** Whether the setup screen can draw here: stdin and stdout are terminals, and TERM names one that moves the cursor. */
export function drawable(env: Record<string, string | undefined>, stdinTTY: boolean, stdoutTTY: boolean) {
  return stdinTTY && stdoutTTY && !!env.TERM && env.TERM !== "dumb"
}

export const realSetupDeps: SetupDeps = {
  ...realDeps,
  terminal: () => drawable(process.env, Boolean(process.stdin.isTTY), Boolean(process.stdout.isTTY)),
  screen: async (argv) => {
    // The screen is Solid JSX, loaded as `ac` loads the TUI.
    const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin")
    ensureSolidTransformPlugin()
    return (await import("@agent-corp/tui/setup")).runSetup(argv, process.cwd())
  },
  // With no office answering, this says so and exits 3, so setUp needs no check of its own.
  openOffice: async () => (await import("./commands/tui")).run([]),
}

/** The value of the last `--home X` or `--home=X` in `argv`, as Python's argparse takes it. */
function homeFlag(argv: string[]): string | undefined {
  let home: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--home" && i + 1 < argv.length) home = argv[++i]
    else if (argv[i].startsWith("--home=")) home = argv[i].slice("--home=".length)
  }
  return home
}

/**
 * `ac init`/`ac onboard`: the install's questions on the setup screen, then the office. With
 * --provider-stdin or --help, or without a terminal to draw on, the install runs as before the screen.
 */
export async function setUp(
  command: "init" | "onboard",
  argv: string[],
  deps: SetupDeps = realSetupDeps,
): Promise<number> {
  const plain = argv.some((a) => a === "--provider-stdin" || a === "-h" || a === "--help")
  if (plain || !deps.terminal()) return syncThenInstall(command, argv, deps)
  // The office that opens after must be the one the install set up, which --home names. The value is kept as
  // given: Python and the TUI's paths both expand a leading `~` and resolve it against the cwd they share.
  const home = homeFlag(argv)
  if (home) process.env.AGENT_CORP_HOME = home
  const synced = await syncVenv(command, deps)
  if (synced !== 0) return synced
  let code: number
  try {
    code = await deps.screen([venvPython(), "-m", "agent_corp.install", command, "--json-prompts", ...argv])
  } catch (e) {
    deps.error(
      `ac ${command}: can't show the setup screen: ${e instanceof Error ? e.message : e}; pass the provider with --provider-stdin instead`,
    )
    return 1
  }
  return code === 0 ? deps.openOffice() : code
}

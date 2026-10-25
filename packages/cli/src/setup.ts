// `opencorp init` and `opencorp onboard`: the install asks its questions on the TUI's setup screen, and the
// office opens once it's done. Without a terminal to draw on, the install runs on this terminal's stdin and stdout.
import { type Deps, type InstallSpawn, absoluteArgs, install, installSpec, realDeps } from "./office"

/** What setting up touches beyond running the install; tests pass fakes. */
export interface SetupDeps extends Deps {
  /** Whether there is a terminal the setup screen can draw on. */
  terminal(): boolean
  /** Runs the install `spec` behind the setup screen; resolves to its exit code once the screen is gone. */
  screen(spec: InstallSpawn): Promise<number>
  /** Opens the office as `opencorp` with no arguments does; resolves to its exit code. */
  openOffice(): Promise<number>
  /** Says what went wrong on stderr. */
  error(message: string): void
}

/** Whether the setup screen can draw here: stdin and stdout are terminals, and TERM names one that moves the cursor. */
export function drawable(env: Record<string, string | undefined>, stdinTTY: boolean, stdoutTTY: boolean) {
  return stdinTTY && stdoutTTY && !!env.TERM && env.TERM !== "dumb"
}

export const realSetupDeps: SetupDeps = {
  ...realDeps,
  terminal: () => drawable(process.env, Boolean(process.stdin.isTTY), Boolean(process.stdout.isTTY)),
  screen: async (spec) => {
    // The screen is Solid JSX, loaded as `opencorp` loads the TUI.
    const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin")
    ensureSolidTransformPlugin()
    return (await import("@opencorp/tui/setup")).runSetup(spec.argv, spec.cwd, spec.env)
  },
  // With no office answering, this says so and exits 3, so setUp needs no check of its own.
  openOffice: async () => (await import("./commands/tui")).run([]),
  error: (message) => console.error(message),
}

/** The value of the last `--home X` or `--home=X` in `argv`, as the install takes it. */
function homeFlag(argv: string[]): string | undefined {
  let home: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--home" && i + 1 < argv.length) home = argv[++i]
    else if (argv[i].startsWith("--home=")) home = argv[i].slice("--home=".length)
  }
  return home
}

/**
 * `opencorp init`/`opencorp onboard`: the install's questions on the setup screen, then the office. With
 * --provider-stdin or --help, or without a terminal to draw on, the install runs on this terminal.
 */
export async function setUp(
  command: "init" | "onboard",
  argv: string[],
  deps: SetupDeps = realSetupDeps,
): Promise<number> {
  const plain = argv.some((a) => a === "--provider-stdin" || a === "-h" || a === "--help")
  if (plain || !deps.terminal()) return install(command, argv, deps)
  const args = absoluteArgs(command, argv)
  const spec = installSpec(command, ["--json-prompts", ...args], deps)
  if (!spec) return 1
  // The office that opens after must be the one the install set up, which --home names. The install runs in the
  // home dir, so a relative --home is made absolute here, where it was typed; `~` the TUI expands as the install does.
  const home = homeFlag(args)
  if (home) process.env.OPENCORP_HOME = home
  let code: number
  try {
    code = await deps.screen(spec)
  } catch (e) {
    deps.error(
      `opencorp ${command}: can't show the setup screen: ${e instanceof Error ? e.message : e}; pass the provider with --provider-stdin instead`,
    )
    return 1
  }
  return code === 0 ? deps.openOffice() : code
}

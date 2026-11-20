// `opencorp init` and `opencorp onboard`: the install runs, and the office opens once it's done. init's install runs on
// this terminal, its interview a chat in the TUI; onboard's asks its questions on the TUI's setup screen. Without a
// terminal to draw on, the install runs on this terminal's stdin and stdout.
import { terminal } from "./chat"
import { type Deps, type InstallSpec, install, installSpec, realDeps } from "./office"

export { drawable, terminal } from "./chat"

/** What setting up touches beyond running the install; tests pass fakes. */
export interface SetupDeps extends Deps {
  /** Whether there is a terminal the setup screen can draw on. */
  terminal(): boolean
  /** Runs the install `spec` behind the setup screen; resolves to its exit code once the screen is gone. */
  screen(spec: InstallSpec): Promise<number>
  /** Opens the office as `opencorp` with no arguments does; resolves to its exit code. */
  openOffice(): Promise<number>
  /** Says what went wrong on stderr. */
  error(message: string): void
}

export const realSetupDeps: SetupDeps = {
  ...realDeps,
  terminal,
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
 * `opencorp init`/`opencorp onboard`: the install, then the office. init's install runs on this terminal, its
 * interview a chat in the TUI; onboard's questions are on the setup screen. With --provider-stdin or --help, or
 * without a terminal to draw on, the install runs on this terminal and no office opens.
 */
export async function setUp(
  command: "init" | "onboard",
  argv: string[],
  deps: SetupDeps = realSetupDeps,
): Promise<number> {
  const plain = argv.some((a) => a === "--provider-stdin" || a === "-h" || a === "--help")
  if (plain || !deps.terminal()) return install(command, argv, deps)
  const spec = installSpec(command, command === "init" ? argv : ["--json-prompts", ...argv], deps)
  if (!spec) return 1
  // The office that opens after must be the one the install set up, which --home names: the spec's, already made
  // absolute where it was typed (the install runs in the home dir); `~` the TUI expands as the install does.
  const home = homeFlag(spec.argv)
  if (home) process.env.OPENCORP_HOME = home
  if (command === "init") {
    const code = await deps.spawn(spec.argv, { cwd: spec.cwd, env: spec.env })
    return code === 0 ? deps.openOffice() : code
  }
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

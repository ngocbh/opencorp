// `opencorp init` and `opencorp onboard`: the install runs on this terminal, and the office opens once it's done.
// init's interview is a chat in the TUI. Without a terminal the TUI can draw on, the install runs on this terminal's
// stdin and stdout, and no office opens.
import { terminal } from "./chat"
import { type Deps, install, installSpec, realDeps } from "./office"

export { drawable, terminal } from "./chat"

/** What setting up touches beyond running the install; tests pass fakes. */
export interface SetupDeps extends Deps {
  /** Whether there is a terminal the TUI can draw on. */
  terminal(): boolean
  /** Opens the office as `opencorp` with no arguments does; resolves to its exit code. */
  openOffice(): Promise<number>
}

export const realSetupDeps: SetupDeps = {
  ...realDeps,
  terminal,
  // With no office answering, this says so and exits 3, so setUp needs no check of its own.
  openOffice: async () => (await import("./commands/tui")).run([]),
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
 * `opencorp init`/`opencorp onboard`: the install on this terminal, then the office. With --provider-stdin or --help,
 * or without a terminal the TUI can draw on, no office opens.
 */
export async function setUp(
  command: "init" | "onboard",
  argv: string[],
  deps: SetupDeps = realSetupDeps,
): Promise<number> {
  const plain = argv.some((a) => a === "--provider-stdin" || a === "-h" || a === "--help")
  if (plain || !deps.terminal()) return install(command, argv, deps)
  const spec = installSpec(command, argv, deps)
  if (!spec) return 1
  // The office that opens after must be the one the install set up, which --home names: the spec's, already made
  // absolute where it was typed (the install runs in the home dir); `~` the TUI expands as the install does.
  const home = homeFlag(spec.argv)
  if (home) process.env.OPENCORP_HOME = home
  const code = await deps.spawn(spec.argv, { cwd: spec.cwd, env: spec.env })
  return code === 0 ? deps.openOffice() : code
}

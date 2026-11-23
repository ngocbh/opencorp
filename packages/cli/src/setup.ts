// `opencorp init` and `opencorp onboard`: the install runs on this terminal, and the office opens once it's done.
// init's interview is a chat in the TUI. Without a terminal the TUI can draw on, the install runs on this terminal's
// stdin and stdout, and no office opens.
import type { Env } from "@opencorp/client/node"
import { homeFlag, terminal } from "./chat"
import { type Deps, install, installSpec, realDeps } from "./office"

export { drawable, terminal } from "./chat"

/** What setting up touches beyond running the install; tests pass fakes. */
export interface SetupDeps extends Deps {
  /** Whether there is a terminal the TUI can draw on. */
  terminal(): boolean
  /** Opens the office at `env`'s home as `opencorp` with no arguments does; resolves to its exit code. */
  openOffice(env: Env): Promise<number>
}

export const realSetupDeps: SetupDeps = {
  ...realDeps,
  terminal,
  // With no office answering, this says so and exits 3, so setUp needs no check of its own.
  openOffice: async (env) => (await import("./commands/tui")).run([], env),
}

/**
 * `opencorp init`/`opencorp onboard` with the environment `env`: the install on this terminal, then the office. With
 * --provider-stdin or --help, or without a terminal the TUI can draw on, no office opens.
 */
export async function setUp(
  command: "init" | "onboard",
  argv: string[],
  env: Env,
  deps: SetupDeps = realSetupDeps,
): Promise<number> {
  const plain = argv.some((a) => a === "--provider-stdin" || a === "-h" || a === "--help")
  if (plain || !deps.terminal()) return install(command, argv, env, deps)
  const spec = installSpec(command, argv, env)
  if (!spec) return 1
  // The office that opens after must be the one the install set up, which --home names: the spec's, already made
  // absolute where it was typed (the install runs in the home dir); `~` the TUI expands as the install does. The
  // install's env stays the caller's, so it can say whether this shell finds the office: init's chat points its TUI at
  // --home itself (`installHooks`).
  const home = homeFlag(spec.argv)
  const code = await deps.spawn(spec.argv, { cwd: spec.cwd, env: spec.env })
  return code === 0 ? deps.openOffice(home ? { ...env, OPENCORP_HOME: home } : env) : code
}

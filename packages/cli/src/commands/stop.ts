import type { Env } from "@opencorp/client/node"
import type { CommandRun } from "../main"
import { type Deps, install, realDeps } from "../office"

/**
 * `opencorp stop [--home H]`: stops the office and leaves its service installed, so launchd or systemd starts it
 * again at the next login and `opencorp start` starts it now. Exits 0 when it stopped or wasn't running, 1 on
 * failure.
 */
export function stop(argv: string[], env: Env, deps: Deps = realDeps): Promise<number> {
  return install("stop", argv, env, deps)
}

export const run: CommandRun = (argv, env) => stop(argv, env)

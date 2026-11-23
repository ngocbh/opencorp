import type { Env } from "@opencorp/client/node"
import type { CommandRun } from "../main"
import { type Deps, install, realDeps } from "../office"

/**
 * `opencorp restart [--home H]`: stops the office and starts it again the way `opencorp onboard` installed it
 * (a stopped office is just started), waits for it to answer, and says the new and old pids. Exits 1 on
 * failure, 3 when there is no office yet.
 */
export function restart(argv: string[], env: Env, deps: Deps = realDeps): Promise<number> {
  return install("restart", argv, env, deps)
}

export const run: CommandRun = (argv, env) => restart(argv, env)

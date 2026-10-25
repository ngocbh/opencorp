import type { CommandRun } from "../main"
import { type Deps, install, realDeps } from "../office"

/**
 * `opencorp start [--home H]`: starts the office the way `opencorp onboard` installed it, unless it is
 * already running, waits for it to answer, and says which it did and the pid. Exits 1 on failure,
 * 3 when there is no office yet.
 */
export function start(argv: string[], deps: Deps = realDeps): Promise<number> {
  return install("start", argv, deps)
}

export const run: CommandRun = (argv) => start(argv)

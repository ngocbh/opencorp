import type { CommandRun } from "../main"
import { type Deps, realDeps, syncThenInstall } from "../office"

/**
 * `ac restart [--home H]`: syncs the venv, so a pulled checkout's dependencies come along, then
 * stops the office and starts it again the way `ac onboard` installed it (a stopped office is
 * just started), waits for it to answer, and says the new and old pids. Exits 1 on failure, 3
 * when there is no office yet.
 */
export function restart(argv: string[], deps: Deps = realDeps): Promise<number> {
  return syncThenInstall("restart", argv, deps)
}

export const run: CommandRun = (argv) => restart(argv)

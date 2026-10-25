import type { CommandRun } from "../main"
import { type Deps, install, realDeps } from "../office"

/**
 * `opencorp offboard [--yes] [--delete-company] [--home H]`: says what it will remove from this machine, asks
 * first unless `--yes`, and keeps a company repo with work that isn't pushed unless `--delete-company`.
 */
export function offboard(argv: string[], deps: Deps = realDeps): Promise<number> {
  return install("offboard", argv, deps)
}

export const run: CommandRun = (argv) => offboard(argv)

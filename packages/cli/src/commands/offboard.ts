import type { CommandRun } from "../main"
import { type Deps, realDeps, runInstall } from "../office"

/**
 * `opencorp offboard [--yes] [--delete-company] [--home H]`: runs the Python offboarding, which says what
 * it will remove from this machine, asks first unless `--yes`, and keeps a company repo with work
 * that isn't pushed unless `--delete-company`. It never syncs the venv: removing needs nothing new.
 */
export function offboard(argv: string[], deps: Deps = realDeps): Promise<number> {
  return runInstall("offboard", argv, deps)
}

export const run: CommandRun = (argv) => offboard(argv)

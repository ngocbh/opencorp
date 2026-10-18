import type { CommandRun } from "../main"
import { type Deps, realDeps, runInstall } from "../office"

/**
 * `opencorp doctor [--home H]`: checks the home, company repo, provider, service, running office, sandbox,
 * and Codex; exits 1 when any check fails.
 */
export function doctor(argv: string[], deps: Deps = realDeps): Promise<number> {
  return runInstall("doctor", argv, deps)
}

export const run: CommandRun = (argv) => doctor(argv)

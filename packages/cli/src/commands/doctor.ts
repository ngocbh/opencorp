import type { CommandRun } from "../main"
import { type Deps, install, realDeps } from "../office"

/**
 * `opencorp doctor [--home H]`: checks the home, company repo, provider, service, running office, sandbox,
 * and Codex. The report is the install's own stdout, printed unchanged; exits 1 when any check fails.
 */
export function doctor(argv: string[], deps: Deps = realDeps): Promise<number> {
  return install("doctor", argv, deps)
}

export const run: CommandRun = (argv) => doctor(argv)

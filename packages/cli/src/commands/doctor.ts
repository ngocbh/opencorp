import type { Env } from "@opencorp/client/node"
import type { CommandRun } from "../main"
import { type Deps, install, realDeps } from "../office"

/**
 * `opencorp doctor [--home H]`: checks the home, company repo, provider, service, running office, sandbox,
 * and Codex. The report is the install's own stdout, printed unchanged; exits 1 when any check fails.
 */
export function doctor(argv: string[], env: Env, deps: Deps = realDeps): Promise<number> {
  return install("doctor", argv, env, deps)
}

export const run: CommandRun = (argv, env) => doctor(argv, env)

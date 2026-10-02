import type { CommandRun } from "../main"
import { type Deps, realDeps, syncThenInstall } from "../office"

/**
 * `ac onboard [--from URL] [--handle H] [--service MODE] [--provider-stdin] [--home H]`: syncs the
 * checkout's venv, then runs the Python onboarding, which sets up this machine's office for an
 * existing company (cloning it from `--from` when there's none here yet). It asks what it needs on
 * this terminal (the model key without echo) and never takes a key as a flag.
 */
export function onboard(argv: string[], deps: Deps = realDeps): Promise<number> {
  return syncThenInstall("onboard", argv, deps)
}

export const run: CommandRun = (argv) => onboard(argv)

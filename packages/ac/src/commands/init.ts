import type { CommandRun } from "../main"
import { type Deps, realDeps, syncThenInstall } from "../office"

/**
 * `ac init [--company NAME] [--name NAME] [--handle H] [--title T] [--agent NAME] [--agent-handle H]
 * [--remote URL] [--no-device] [--service MODE] [--provider-stdin] [--home H]`: syncs the checkout's
 * venv, then runs the Python init, which creates the company (refusing if there is one) and then
 * onboards this machine. It asks what it needs on this terminal and never takes a key as a flag.
 */
export function init(argv: string[], deps: Deps = realDeps): Promise<number> {
  return syncThenInstall("init", argv, deps)
}

export const run: CommandRun = (argv) => init(argv)

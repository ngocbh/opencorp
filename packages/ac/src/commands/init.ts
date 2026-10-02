import type { CommandRun } from "../main"
import { type Deps, realDeps, syncThenInstall } from "../office"

/**
 * `ac init [--company NAME] [--name NAME] [--handle H] [--title T] [--agent NAME] [--agent-handle H]
 * [--remote URL] [--no-device] [--service MODE] [--provider-stdin] [--home H]`: syncs the checkout's
 * venv, then runs the Python init, which asks for the model, creates the company from an interview
 * with it (refusing if there is one), and then onboards this machine. The flags answer the interview
 * up front; it asks the rest on this terminal and never takes a key as a flag.
 */
export function init(argv: string[], deps: Deps = realDeps): Promise<number> {
  return syncThenInstall("init", argv, deps)
}

export const run: CommandRun = (argv) => init(argv)

import type { CommandRun } from "../main"
import { type SetupDeps, realSetupDeps, setUp } from "../setup"

/**
 * `ac init [--company NAME] [--name NAME] [--handle H] [--title T] [--agent NAME] [--agent-handle H]
 * [--remote URL] [--no-device] [--service MODE] [--provider-stdin] [--home H]`: syncs the checkout's
 * venv, then runs the Python init behind the setup screen. It asks for the model, creates the company
 * from an interview with it (refusing if there is one) and onboards this machine; then the office opens
 * as `ac` opens it. The flags answer the interview up front; a key is never a flag. With
 * `--provider-stdin` it asks nothing. Without a terminal (or with TERM=dumb), it runs on stdin and
 * stdout as it did before the setup screen.
 */
export function init(argv: string[], deps: SetupDeps = realSetupDeps): Promise<number> {
  return setUp("init", argv, deps)
}

export const run: CommandRun = (argv) => init(argv)

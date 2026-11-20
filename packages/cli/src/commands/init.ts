import type { CommandRun } from "../main"
import { type SetupDeps, realSetupDeps, setUp } from "../setup"

/**
 * `opencorp init [--company NAME] [--name NAME] [--handle H] [--title T] [--agent NAME] [--agent-handle H]
 * [--remote URL] [--no-device] [--service MODE] [--provider-stdin] [--home H]`: runs the install's init on this
 * terminal. It asks there for the model, a password and a remote, creates the company from an interview with
 * OpenCorp, a chat in the TUI (refusing if there is a company already), and onboards this machine; then the office
 * opens as `opencorp` opens it. The flags answer the interview up front; a key is never a flag. With
 * `--provider-stdin` it asks nothing. Without a terminal the TUI can draw on (or with TERM=dumb), the
 * company comes from the flags and defaults, and no office opens.
 */
export function init(argv: string[], deps: SetupDeps = realSetupDeps): Promise<number> {
  return setUp("init", argv, deps)
}

export const run: CommandRun = (argv) => init(argv)

import type { Env } from "@opencorp/client/node"
import type { CommandRun } from "../main"
import { type SetupDeps, realSetupDeps, setUp } from "../setup"

/**
 * `opencorp onboard [--from URL] [--handle H] [--service MODE] [--provider-stdin] [--home H]`: runs the
 * install's onboarding on this terminal. It sets up this machine's office for an existing company (cloning it
 * from `--from` when there's none here yet), asking on the terminal for what it needs: which of its humans you
 * are, their password, and the model and its key. Then the office opens as `opencorp` opens it. A key is never a
 * flag. With `--provider-stdin` it asks nothing. Without a terminal the TUI can draw on (or with TERM=dumb), it
 * runs on stdin and stdout, and no office opens.
 */
export function onboard(argv: string[], env: Env, deps: SetupDeps = realSetupDeps): Promise<number> {
  return setUp("onboard", argv, env, deps)
}

export const run: CommandRun = (argv, env) => onboard(argv, env)

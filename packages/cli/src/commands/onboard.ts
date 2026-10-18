import type { CommandRun } from "../main"
import { type SetupDeps, realSetupDeps, setUp } from "../setup"

/**
 * `ac onboard [--from URL] [--handle H] [--service MODE] [--provider-stdin] [--home H]`: syncs the
 * checkout's venv, then runs the Python onboarding behind the setup screen. It sets up this machine's
 * office for an existing company (cloning it from `--from` when there's none here yet), asking for
 * what it needs, the model key among them; then the office opens as `ac` opens it. A key is never a
 * flag. With `--provider-stdin` it asks nothing. Without a terminal (or with TERM=dumb), it runs on
 * stdin and stdout as it did before the setup screen.
 */
export function onboard(argv: string[], deps: SetupDeps = realSetupDeps): Promise<number> {
  return setUp("onboard", argv, deps)
}

export const run: CommandRun = (argv) => onboard(argv)

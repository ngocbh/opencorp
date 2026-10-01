import os from "node:os"
import path from "node:path"
import type { CommandRun } from "../main"
import { type Deps, REPO, realDeps, runInstall } from "../office"

/**
 * `ac onboard [--service MODE] [--provider-stdin] [--company NAME] [--name NAME] [--handle H]
 * [--agent NAME] [--agent-handle H] [--no-hire] [--home H]`: syncs the checkout's venv, then runs
 * the Python onboarding, which asks what it needs on this terminal (the model key without echo)
 * and never takes a key as a flag.
 */
export async function onboard(argv: string[], deps: Deps = realDeps): Promise<number> {
  // The venv is what runs the onboarding, so it must exist and match the checkout first.
  const uv = deps.which("uv") ?? [path.join(os.homedir(), ".local", "bin", "uv")].find((p) => deps.exists(p))
  if (!uv) {
    deps.error("ac onboard: uv not found; install it (https://docs.astral.sh/uv/) and run `ac onboard` again")
    return 1
  }
  const synced = await deps.spawn([uv, "sync", "--frozen"], REPO)
  if (synced !== 0) return synced
  return runInstall("onboard", argv, deps)
}

export const run: CommandRun = (argv) => onboard(argv)

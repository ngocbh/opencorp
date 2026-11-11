/** The fixed texts the owner reads before learning the path to HQ and before saving it, kept out of the flow so the
 *  model can't edit them; the agent's risks specific to the setup follow them. */
import type { ReachPaths } from "./paths.ts"

/** Shown before every learning run, ahead of asking to use the model. */
export const BEFORE_LEARNING = [
  "Learning uses a model, which sees each command it runs and their output and errors: hostnames, your username, paths and job lists.",
  "Approving a command runs it as you, with your SSH keys, and only you check it.",
] as const

/** Shown by save_access with the two files, before the owner saves; the agent's risks for this setup follow. */
export const beforeSaving = (paths: ReachPaths): string[] => [
  "The script, and `opencorp hq --check` on HQ's machine, run now and on every visit.",
  "While `opencorp hq` runs, anything running as you on this machine can reuse its SSH connections without Duo. A crash or `kill -9` closes them within seconds; only if its watcher dies too (`kill -9` of its process group) do they stay while an HQ tab is open, the login node's for 60 s more.",
  "Anything on this machine that can reach the port reaches HQ, though HQ still asks it to sign in (its cookie is SameSite=Strict, and the Host header is checked). So don't run `opencorp hq` on a machine others share, such as a cluster login node: they share 127.0.0.1.",
  "Each new node HQ runs on asks you to accept its host key; check it the way your cluster documents.",
  "The saved files record the cluster's layout, and backups copy them.",
  `${paths.provider} holds a key or a token.`,
]

/** The answer that starts a learning run. */
export const LEARN = "Learn it"
/** Asked before learning a first path. */
export const LEARN_QUESTION = "Learn how to reach HQ from here? This uses the model."
/** Asked before learning again in place of a saved path. */
export const RELEARN_QUESTION = "Relearn? This uses the model."

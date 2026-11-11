/** The replay on every visit: run the approved reach.sh, then read what it printed and how it exited. */
import { lastStderr, type Ran, type ReachContext, readStatuses, resetStatus, runChild, sshEnv } from "./ssh.ts"
import { parseSpec, type Spec } from "./spec.ts"

export type Outcome = "ok" | "no_office" | "unreachable" | "broken"
/** What a replay found: the checked spec when `ok` (the key is left out otherwise), else why not. */
export interface Reached {
  outcome: Outcome
  spec?: Spec
  detail: string
}

/** What a run of reach.sh means. Any ssh that exited 255 (the wrapper records each), or running out of time, is
 *  "couldn't connect", whatever the script returned; then 3 is no office, 0 with a valid spec ok, the rest broken. */
export function classify(ran: Ran, statuses: readonly number[]): Reached {
  if (ran.timedOut) return { outcome: "unreachable", detail: "reach.sh didn't finish within 5 minutes" }
  if (ran.code === 255 || statuses.includes(255))
    return { outcome: "unreachable", detail: lastStderr(ran) || "ssh exited 255" }
  if (ran.code === 3) return { outcome: "no_office", detail: lastStderr(ran) || "reach.sh found no office (exit 3)" }
  if (ran.code !== 0)
    return { outcome: "broken", detail: `reach.sh exited ${ran.code}${lastStderr(ran) ? `: ${lastStderr(ran)}` : ""}` }
  const parsed = parseSpec(ran.stdout)
  if ("problem" in parsed)
    return { outcome: "broken", detail: `reach.sh printed a spec that isn't valid: ${parsed.problem}` }
  return { outcome: "ok", spec: parsed.spec, detail: "" }
}

/** Runs `file` with `/bin/sh` in the hq folder, with only `sshEnv` (our wrapper first on PATH), stdin from /dev/null
 *  and its stderr echoed to the owner, for up to `promptMs` (its ssh may ask for Duo); then classifies the run with
 *  the exits the wrapper recorded. */
export async function runScript(file: string, ctx: ReachContext): Promise<Reached> {
  resetStatus(ctx)
  const ran = await runChild(["/bin/sh", file], {
    env: sshEnv(ctx),
    cwd: ctx.paths.dir,
    timeoutMs: ctx.limits.promptMs,
    signal: ctx.signal,
    echo: ctx.echo,
  })
  return classify(ran, readStatuses(ctx))
}

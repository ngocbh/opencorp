/** Connecting to HQ's machine once reach.sh gave the spec: the node master, `opencorp hq --check` over it, the
 *  forward of HQ's socket to a local port, HQ's health through that port, and the sign-in code. */
import { HqStatus } from "@opencorp/protocol"
import { cleanOutput, lastStderr, type Ran } from "./ssh.ts"
import { hqSocket, lastJson } from "./spec.ts"

export type FailureKind = "unreachable" | "no_office" | "not_ready" | "broken" | "port_taken" | "no_forward"
/** A step of reaching HQ failed; `kind` is its row of the failure table. */
export class ReachFailure extends Error {
  override name = "ReachFailure"
  constructor(
    readonly kind: FailureKind,
    message: string,
  ) {
    super(message)
  }
}

/** HQ's status from `opencorp hq --check --json` over the master, or the failure it shows. */
export function classifyCheck(ran: Ran): HqStatus {
  if (ran.timedOut || ran.code === 255)
    throw new ReachFailure(
      "unreachable",
      ran.timedOut ? "`opencorp hq --check` there didn't answer within 60 s" : lastStderr(ran) || "ssh exited 255",
    )
  if (ran.code === 3) throw new ReachFailure("no_office", lastStderr(ran) || "no office answers there")
  // The wrapper ends in `exec "${OPENCORP_BUN:-bun}"`: 127 is also a missing bun.
  if (ran.code === 127)
    throw new ReachFailure("broken", "no opencorp at the saved path, or no bun for it (exit 127; see env.OPENCORP_BUN)")
  if (ran.code === 2) throw new ReachFailure("not_ready", "`opencorp` there has no `hq --check`; update that checkout")
  if (ran.code === 1) throw new ReachFailure("not_ready", lastStderr(ran) || "`opencorp hq --check` failed there")
  if (ran.code !== 0) throw new ReachFailure("broken", `\`opencorp hq --check\` exited ${ran.code}`)
  const parsed = HqStatus.safeParse(lastJson(ran.stdout))
  if (!parsed.success) throw new ReachFailure("broken", "`opencorp hq --check --json` there printed no status JSON")
  const status = parsed.data
  if (!hqSocket(status.socket)) throw new ReachFailure("broken", "HQ's socket path there can't be forwarded as is")
  if (status.socket_error !== null)
    throw new ReachFailure("not_ready", `hq.sock isn't listening (${cleanOutput(status.socket_error)})`)
  if (status.health.app === null) throw new ReachFailure("not_ready", "HQ's web app isn't built")
  return status
}

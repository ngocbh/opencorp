/** Who drives a run the office starts itself, each flow's label, and the outcomes and reasons the office writes
 *  when a run ends. */

/** The driver of the runs the office starts itself (debriefs). */
export const OFFICE = "office"
/** A session's runs' flow label, by the session's kind. */
export const FLOWS: Readonly<Record<string, string>> = Object.freeze({
  main: "chat",
  side: "side_chat",
  profile_manager: "profile_manager",
})
export const DEBRIEF = "debrief"

export const LOOP_LIMIT = "stopped at its loop limit"
export const WORKER_STOPPED = "worker stopped"
export const COULDNT_START = "couldn't start"
export const COULDNT_RESUME = "couldn't resume"
export const OFFICE_STOPPED = "the office stopped"
export const OFFICE_REPLACED = "the office stopped; a fresh run replaced it"
export const WORKER_REPLACED = "its worker stopped; a fresh run replaced it"
export const NEW_MODEL = "replaced by a fresh run on the new model"
export const CARD_CLOSED = "its card closed while it wasn't running"
export const BAD_OUTPUT = "bad output"
/** A session ended by End while its reply was stopped by the cost cap. */
export const ENDED_OVER_CAP = "ended over its cost cap"

/** How a run ended, as its outcome is written. */
export class RunEnd {
  readonly outcome: string
  readonly reason: string | null
  readonly failedNode: string | null

  constructor(outcome: string, reason: string | null = null, failedNode: string | null = null) {
    this.outcome = outcome
    this.reason = reason
    this.failedNode = failedNode
    Object.freeze(this)
  }
}

/** The flow label of a session of `kind`'s runs. */
export function flowLabel(kind: string): string {
  // Own keys only, so an inherited name such as "constructor" maps to itself.
  return Object.hasOwn(FLOWS, kind) ? FLOWS[kind] : kind
}

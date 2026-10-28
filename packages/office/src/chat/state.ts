/** A session's run state, and the status writes that must not race the steps that finish a session. */
import type { SessionRecord, Store } from "../store/store.ts"

type Status = SessionRecord["status"]

/** A request the harness refuses; routes answer it as an `ApiError` with `status`. */
export class HarnessError extends Error {
  override name = "HarnessError"

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** The 422 `not_an_agent` a chat with a person who has no main flow gets; like every 422, it names the field, not
 *  its value. */
export function notAnAgent(): HarnessError {
  return new HarnessError(422, "not_an_agent", "the person has no main flow to chat with")
}

/** Session statuses that have (or should have) a live run. */
export const LIVE: readonly Status[] = ["starting", "idle", "busy", "waiting", "ending"]

/** The statuses the run state replaces; ending, debriefing and finished ones are written only by their own steps. */
export const SETTLED: readonly Status[] = ["starting", "idle", "busy", "waiting"]

/** What the run waits in decides its state: someone must act (waiting), else a node runs (busy), else idle. */
export function runState({ waiting, running }: { waiting: boolean; running: boolean }): "waiting" | "busy" | "idle" {
  return waiting ? "waiting" : running ? "busy" : "idle"
}

/** The fields that store `status` outside the run state (ending, debriefing or a finished one): nobody is waited
 *  on, and no cap holds the session. */
export function notWaiting<S extends Status>(status: S): { status: S; waiting_on: string[]; capped: false } {
  return { status, waiting_on: [], capped: false }
}

/**
 * Writes `status`, `waiting_on` and `capped` in one transaction, if the stored status allows it.
 *
 * A session that is ending, debriefing or finished is left alone; a starting one moves only to `fromStarting`
 * (the run is starting until it first shows a turn or a question). `waitingOn` (each person once) and `capped` are
 * kept only while waiting. Returns the stored session, or undefined when nothing was written.
 */
export function writeState(
  store: Store,
  sessionId: string,
  status: Status,
  waitingOn: Iterable<string | null | undefined>,
  options?: { capped?: boolean; fromStarting?: readonly Status[] },
): SessionRecord | undefined {
  const fromStarting = options?.fromStarting ?? ["idle", "waiting"]
  return store.transaction(() => {
    const current = store.getSession(sessionId)
    if (current === undefined || !SETTLED.includes(current.status)) return undefined
    if (current.status === "starting" && !fromStarting.includes(status)) return undefined
    const waiting = status === "waiting"
    const who = waiting ? [...new Set([...waitingOn].filter((w): w is string => !!w))] : []
    const held = (options?.capped ?? false) && waiting
    const same =
      current.status === status &&
      current.capped === held &&
      current.waiting_on.length === who.length &&
      current.waiting_on.every((w, i) => w === who[i])
    // An unchanged write would still emit session.updated.
    if (same) return current
    return store.updateSession(sessionId, { status, waiting_on: who, capped: held })
  })
}

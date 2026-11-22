/** A session's run state, and the status writes that must not race the steps that finish a session. */
import { LIVE, type SessionRecord, type Store } from "../store/store.ts"

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
 * (the run is starting until it first shows its turn, a question or a reply). `waitingOn` (each person once) and
 * `capped` are kept only while waiting. Returns the stored session, or undefined when nothing was written.
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

/**
 * The stored instrument session `id` of `chat`, which `chat`'s instrument continues after an office restart, on the
 * harness's own session `harnessSessionId` its record names. Refused 409 `not_live` once the chat has ended or is
 * ending: its sessions stay ended. Refused 409 `not_resumable`, and logged, unless the stored session is that chat's
 * instrument on `harness`, of the chat's person, on that harness session: a record that doesn't match is never
 * trusted.
 */
export function resumable(
  store: Store,
  chat: SessionRecord,
  id: string,
  { harness, harnessSessionId, log }: { harness: "codex" | "claude"; harnessSessionId: string; log: (line: string) => void },
): SessionRecord {
  const title = harness === "codex" ? "Codex" : "Claude Code"
  const current = store.getSession(chat.id)
  if (current === undefined || !LIVE.includes(current.status) || current.status === "ending") {
    throw new HarnessError(409, "not_live", `this chat has ended, so its ${title} sessions stay ended`)
  }
  const session = store.getSession(id)
  const matches =
    session !== undefined &&
    session.kind === "instrument" &&
    session.harness === harness &&
    session.instrument_of === chat.id &&
    session.person === chat.person &&
    session.harness_session_id === harnessSessionId
  if (!matches) {
    log(`${harness} session ${id}: its record doesn't match the office's session of chat ${chat.id}, so it isn't continued`)
    throw new HarnessError(
      409,
      "not_resumable",
      `this ${title} session's record doesn't match the office's own, so it can't be continued; start begins a new one`,
    )
  }
  return session
}

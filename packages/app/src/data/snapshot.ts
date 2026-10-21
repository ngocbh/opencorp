import { applyCompany, upsertSession, type OfficeState, type Snapshot } from "@opencorp/client"
import type { Session } from "@opencorp/protocol"

/** Current work, which HQ fetches, counts and lists. An idle session is history, reopened with /sessions in the TUI. */
export const ACTIVE: Session["status"][] = ["starting", "busy", "waiting", "ending", "debriefing"]

/**
 * HQ's snapshot on every (re)connect: the company at HEAD, active sessions, open questions, and costs since `from()`.
 * It replaces every open question it held, so the sync never re-reads them by id (HQ serves no route for that).
 */
export function hqSnapshot(from: () => string): Snapshot {
  return async (client) => {
    const [view, sessions, questions, costs] = await Promise.all([
      client.company.get(),
      client.sessions.list({ status: ACTIVE, limit: 500 }),
      client.questions.list({ status: "open" }),
      client.costs.since(from()),
    ])
    return (s: OfficeState) => {
      applyCompany(s, view)
      s.sessions = []
      for (const session of sessions) upsertSession(s, session)
      for (const [id, q] of Object.entries(s.questions)) if (q.status === "open") delete s.questions[id]
      for (const q of questions) s.questions[q.id] = q
      s.costs = costs
    }
  }
}

// The label a client shows for a session's status.
import type { Session } from "@opencorp/protocol"

/** What a session's status says: a waiting one names who must act (`waiting on @ann, @lead`), after `cost cap
 * reached` while its cap holds it. */
export function statusLabel(session: Session): string {
  if (session.status !== "waiting") return session.status
  const who = (session.waiting_on ?? []).map((h) => `@${h}`).join(", ")
  const on = who ? `waiting on ${who}` : "waiting"
  return session.capped ? `cost cap reached, ${on}` : on
}

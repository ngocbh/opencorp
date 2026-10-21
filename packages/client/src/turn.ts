// Which open question is a chat's own turn. The office's chat flow keeps a `human_input` open at
// its turn node while the chat is idle; clients show that one as the input box, not a card.
import type { Question, Session } from "@opencorp/protocol"

/** The turn node's path in the office's chat flows. */
export const CHAT_TURN_PATH = "chat/ask"

/** `node_id` without the `#N` that LOOP and MAP add to each segment: `chat#3/ask` → `chat/ask`. */
export function turnPath(nodeId: string) {
  return nodeId
    .split("/")
    .map((seg) => seg.replace(/#\d+$/, ""))
    .join("/")
}

/** Whether `q` is a chat's own turn (its input box), not a card. */
export function isTurn(q: Question) {
  return q.source === "human_input" && !!q.node_id && turnPath(q.node_id) === CHAT_TURN_PATH
}

/** What a session's status says: a waiting one names who must act (`waiting on @ann, @lead`), after `cost cap
 * reached` while its cap holds it. */
export function statusLabel(session: Session): string {
  if (session.status !== "waiting") return session.status
  const who = (session.waiting_on ?? []).map((h) => `@${h}`).join(", ")
  const on = who ? `waiting on ${who}` : "waiting"
  return session.capped ? `cost cap reached, ${on}` : on
}

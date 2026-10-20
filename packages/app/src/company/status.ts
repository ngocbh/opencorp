import { isTurn } from "@opencorp/client"
import type { Question, Session } from "@opencorp/protocol"
import type { TreeNode } from "./tree"

export type Status = "waiting" | "busy" | "idle" | "away"
/** Most urgent first. */
export const URGENCY: Status[] = ["waiting", "busy", "idle", "away"]
const BUSY = new Set<Session["status"]>(["starting", "busy", "ending", "debriefing"])
/** profile_manager sessions are the office's work, not the person's. */
const COUNTED = new Set<Session["kind"]>(["main", "side"])

const urgent = (a: Status, b: Status) => (URGENCY.indexOf(a) <= URGENCY.indexOf(b) ? a : b)

/** Open questions shown as cards: an idle chat keeps one open at its turn node, which is its input box, not a card. */
export const cards = (questions: Iterable<Question>) => [...questions].filter((q) => q.status === "open" && !isTurn(q))

/** Each person's status by their main and side sessions; a person not in the map is away. */
export function statusByPerson(sessions: Session[], questions: Iterable<Question>): Map<string, Status> {
  const out = new Map<string, Status>()
  const bump = (handle: string, st: Status) => out.set(handle, urgent(st, out.get(handle) ?? "away"))
  const byId = new Map(sessions.map((x) => [x.id, x]))
  for (const x of sessions) {
    if (!COUNTED.has(x.kind)) continue
    if (BUSY.has(x.status)) bump(x.person, "busy")
    else if (x.status === "idle") bump(x.person, "idle")
  }
  for (const q of cards(questions)) {
    const x = byId.get(q.session_id)
    if (x && COUNTED.has(x.kind)) bump(x.person, "waiting")
  }
  return out
}

/** A branch's status: its most urgent member's, the person at its top included. */
export function branchStatus(node: TreeNode, m: Map<string, Status>): Status {
  return node.children.reduce((st, c) => urgent(st, branchStatus(c, m)), m.get(node.person.handle) ?? "away")
}

/**
 * Who should answer `q`: for `ask_manager`, its work item's assignee (the asker's manager at the session's pinned
 * commit); for anything else, who opened the session, else the CEO, as the harness's `_owner` decides (it uses the
 * pinned CEO; the app uses HEAD's).
 */
export function recipient(
  q: Question,
  session: Session | undefined,
  ceo: string | null,
  assignee: (workItemId: string) => string | null | undefined,
): string | null {
  if (q.source === "ask_manager") return q.work_item_id ? (assignee(q.work_item_id) ?? null) : null
  return session?.opened_by ?? ceo
}

/** For `viewer`: how many open cards each asking person has for them. */
export function needsYou(
  viewer: string,
  sessions: Session[],
  questions: Iterable<Question>,
  ceo: string | null,
  assignee: (workItemId: string) => string | null | undefined,
): Map<string, number> {
  const byId = new Map(sessions.map((x) => [x.id, x]))
  const out = new Map<string, number>()
  for (const q of cards(questions)) {
    const session = byId.get(q.session_id)
    if (recipient(q, session, ceo, assignee) !== viewer) continue
    const asker = session?.person ?? q.asker
    out.set(asker, (out.get(asker) ?? 0) + 1)
  }
  return out
}

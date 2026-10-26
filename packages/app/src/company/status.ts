import type { CostReport, Question, Session } from "@opencorp/protocol"
import type { TreeNode } from "./tree"

export type Status = "waiting" | "busy" | "idle" | "away"
/** Most urgent first. */
export const URGENCY: readonly Status[] = ["waiting", "busy", "idle", "away"]
const BUSY = new Set<Session["status"]>(["starting", "busy", "ending", "debriefing"])
/** profile_manager sessions are the office's work, not the person's. */
const COUNTED = new Set<Session["kind"]>(["main", "side"])

const urgent = (a: Status, b: Status) => (URGENCY.indexOf(a) <= URGENCY.indexOf(b) ? a : b)

/** The office filter: one office's name, or null for every office (the only choice while HQ shows one office). */
export type OfficeFilter = string | null

/** The sessions the office filter keeps: on null, every office's, so status adds up across offices. */
export const inOffice = (sessions: Session[], office: OfficeFilter) =>
  office === null ? sessions : sessions.filter((x) => x.office === office)

/** Open questions, which show as cards. */
export const cards = (questions: Iterable<Question>) => [...questions].filter((q) => q.status === "open")

/**
 * Each person's status by their active main and side sessions and their cards; idle sessions don't count, so a person
 * with only idle sessions is away. A person not in the map is away.
 */
export function statusByPerson(sessions: Session[], questions: Iterable<Question>): Map<string, Status> {
  const out = new Map<string, Status>()
  const bump = (handle: string, st: Status) => out.set(handle, urgent(st, out.get(handle) ?? "away"))
  const byId = new Map(sessions.map((x) => [x.id, x]))
  for (const x of sessions) {
    if (!COUNTED.has(x.kind)) continue
    if (BUSY.has(x.status)) bump(x.person, "busy")
    else if (x.status === "waiting") bump(x.person, "waiting")
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
  session: Session,
  ceo: string | null,
  assignee: (workItemId: string) => string | null | undefined,
): string | null {
  if (q.source === "ask_manager") return q.work_item_id ? (assignee(q.work_item_id) ?? null) : null
  return session.opened_by ?? ceo
}

/**
 * For `viewer`: how many open cards each asking person has for them. A card counts only when its session is in
 * `sessions`, as for status, so the office filter and non-live sessions treat both alike.
 */
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
    if (!session || recipient(q, session, ceo, assignee) !== viewer) continue
    out.set(session.person, (out.get(session.person) ?? 0) + 1)
  }
  return out
}

export type Totals = { people: number; busy: number; waiting: number; needsYou: number; usd: number; unpriced: number }

/** What a collapsed branch shows: counts and cost over everyone in it. */
export function totals(node: TreeNode, status: Map<string, Status>, needs: Map<string, number>, costs: CostReport | null): Totals {
  const h = node.person.handle
  const st = status.get(h)
  const cost = costs?.people[h]
  const own: Totals = {
    people: 1,
    busy: st === "busy" ? 1 : 0,
    waiting: st === "waiting" ? 1 : 0,
    needsYou: needs.get(h) ?? 0,
    usd: cost?.usd ?? 0,
    unpriced: cost?.unpriced_sessions ?? 0,
  }
  return node.children.reduce((t, c) => {
    const k = totals(c, status, needs, costs)
    return {
      people: t.people + k.people,
      busy: t.busy + k.busy,
      waiting: t.waiting + k.waiting,
      needsYou: t.needsYou + k.needsYou,
      usd: t.usd + k.usd,
      unpriced: t.unpriced + k.unpriced,
    }
  }, own)
}

import type { PersonCost } from "@opencorp/protocol"
import type { Status, Totals } from "./status"

/** "$0.42", or "$0.00 +1 unpriced" when harness sessions (Codex, Claude) ran: the office doesn't price their tokens. */
export function costText(usd: number, unpriced: number) {
  return `$${usd.toFixed(2)}${unpriced > 0 ? ` +${unpriced} unpriced` : ""}`
}

/** A person's cost for the window; "$0.00" for someone with no spend. */
export const personCost = (c: PersonCost | undefined) => costText(c?.usd ?? 0, c?.unpriced_sessions ?? 0)

/** What a closed branch says about everyone in it. */
export function totalsText(t: Totals) {
  return [
    `${t.people} ${t.people === 1 ? "person" : "people"}`,
    t.busy && `${t.busy} busy`,
    t.waiting && `${t.waiting} waiting`,
    t.needsYou && `${t.needsYou} for you`,
    costText(t.usd, t.unpriced),
  ]
    .filter(Boolean)
    .join(" · ")
}

/**
 * What a person's row says to a screen reader after its name: their status (the branch's while it's closed), the
 * viewer's cards from them, their cost, and a closed branch's totals.
 */
export function describe(d: { status: Status; branch: boolean; needs: number; cost: string; totals?: string }) {
  return [
    d.branch ? `${d.status} in this branch` : d.status,
    d.needs > 0 && `${d.needs} ${d.needs === 1 ? "card" : "cards"} for you`,
    d.cost,
    d.totals,
  ]
    .filter(Boolean)
    .join(" · ")
}

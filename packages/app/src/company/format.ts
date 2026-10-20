import type { PersonCost } from "@opencorp/protocol"
import type { Totals } from "./status"

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

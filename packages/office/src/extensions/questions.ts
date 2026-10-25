/** Question cards: card actions and answer checks, wired into the session actor. */
import type { Office } from "../daemon/office.ts"
import { Cards } from "../questions/cards.ts"

/** Put `Cards` in `office.cards` and hook it into the session actor; no actor, no cards. */
export function register(office: Office): void {
  const harness = office.harness
  if (harness === undefined) return
  const cards = new Cards(office, harness)
  office.cards = cards
  harness.hooks.answerCheck.push(cards.check.bind(cards))
  office.onStop.push(() => cards.close())
}

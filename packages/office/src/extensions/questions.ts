/** Question cards: card actions, answer checks and side chats, wired into the session harness. */
import type { Office } from "../daemon/office.ts"
import { Cards } from "../questions/cards.ts"

/** Put `Cards` in `office.cards` and hook it into the session harness: its answer checks, the side chats' exit
 *  refusal, seed and discussion copies, and the carried and expired cards; no harness, no cards. */
export function register(office: Office): void {
  const harness = office.harness
  if (harness === undefined) return
  const cards = new Cards(office, harness)
  office.cards = cards
  harness.hooks.answerCheck.push(cards.check.bind(cards))
  harness.hooks.promptCheck.push(cards.refuseExit.bind(cards))
  harness.hooks.turnContext.push(cards.firstTurn.bind(cards))
  harness.hooks.questionStored.push(cards.stored.bind(cards))
  harness.hooks.workerExited.push(cards.sideExited.bind(cards))
  harness.hooks.sessionEnded.push(cards.ended.bind(cards))
  // Relies on the harness adding its own onStart (its resume) before the extensions load, so the sweep runs after it.
  office.onStart.push(() => cards.sweep())
  office.onStop.push(() => cards.close())
}

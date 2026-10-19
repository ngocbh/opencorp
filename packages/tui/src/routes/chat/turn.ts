import { openQuestions, type OfficeState, isTurn } from "@opencorp/client"

/** A session's open questions that show as cards, oldest first. */
export function cardQuestions(state: OfficeState, sessionId: string) {
  return openQuestions(state, sessionId).filter((q) => !isTurn(q))
}

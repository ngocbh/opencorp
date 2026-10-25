/** Question-card actions (answer, chat about this, send back, stop). */
import type { Hooks } from "../chat/hooks.ts"
import { HarnessError } from "../chat/state.ts"
import { MAIN_CHAT } from "../chat/turns.ts"
import type { Office } from "../daemon/office.ts"
import type { QuestionRecord, SessionRecord, Store } from "../store/store.ts"
import { InvalidAnswer, checkAnswer } from "./checker.ts"

export type AnswerKind = NonNullable<QuestionRecord["answer_kind"]>

/** What the cards ask of the session actor (Codex sessions now, the chat harness later). */
export interface CardActor {
  /** The hooks the questions extension adds the cards' checks and notifications to. */
  readonly hooks: Hooks
  /** Answer an open question as `by` after the `answerCheck` hooks and deliver it to its run; throws
   *  `HarnessError` (404 not_found, 409 not_open, 422 invalid_answer, ...). */
  answer(
    questionId: string,
    value: unknown,
    kind: AnswerKind,
    options?: { by?: string | null },
  ): Promise<QuestionRecord>
  /** Esc on a live session: its model questions are answered interrupted and the reply stops; throws
   *  `HarnessError` when the session has no run to stop. */
  interrupt(sessionId: string): Promise<void>
}

const HARNESS_ONLY_ANSWER = "a Codex card takes only an answer; press Esc in the chat to interrupt Codex's turn"

/** What a question card can do. `register` wires its hook methods into the actor's hooks. */
export class Cards {
  readonly office: Office
  readonly actor: CardActor
  readonly store: Store

  constructor(office: Office, actor: CardActor) {
    this.office = office
    this.actor = actor
    this.store = office.store
  }

  /** Answer a card as `by`: check and convert the answer, then answer it through the actor. */
  async answer(
    questionId: string,
    answer: unknown,
    kind: "option" | "text",
    { by = null }: { by?: string | null } = {},
  ): Promise<QuestionRecord> {
    const question = this.#open(questionId)
    let value: unknown
    try {
      value = checkAnswer(question, answer, kind)
    } catch (error) {
      if (error instanceof InvalidAnswer) throw new HarnessError(422, "invalid_answer", error.message)
      throw error
    }
    return this.actor.answer(questionId, value, kind, { by })
  }

  /** "Chat about this": refuses what can't have a side chat, then answers 501, since side chats aren't built. */
  async openSide(questionId: string, _text: string, _options: { by?: string | null } = {}): Promise<SessionRecord> {
    const question = this.#open(questionId)
    this.#notHarness(question)
    if (this.#isTurn(question)) {
      throw new HarnessError(422, "not_a_card", "a chat turn is not a question card; reply in the chat")
    }
    throw new HarnessError(501, "not_implemented", "side chats are not implemented yet")
  }

  /** `answerCheck`: refuse an answer that doesn't fit its card (turn questions aren't cards). */
  check(question: QuestionRecord, answer: unknown, kind: AnswerKind): string | null {
    if (this.#isTurn(question)) return null
    try {
      checkAnswer(question, answer, kind)
    } catch (error) {
      if (error instanceof InvalidAnswer) return error.message
      throw error
    }
    return null
  }

  #open(questionId: string): QuestionRecord {
    const question = this.store.getQuestion(questionId)
    if (question === undefined) throw new HarnessError(404, "not_found", `no question ${questionId}`)
    if (question.status !== "open") {
      throw new HarnessError(409, "not_open", `question ${questionId} is ${question.status}`)
    }
    return question
  }

  /** Throws `422 harness_card` for a harness card, which a side chat, send back or stop can't reach. */
  #notHarness(question: QuestionRecord): void {
    if (question.source === "harness") throw new HarnessError(422, "harness_card", HARNESS_ONLY_ANSWER)
  }

  #isTurn(question: QuestionRecord): boolean {
    // Both chat flows the office runs share the turn path chat/ask.
    return question.source === "ask" && MAIN_CHAT.isTurn(question.node_id)
  }
}

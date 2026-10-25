/** Question-card actions (answer, chat about this, send back, stop). */
import type { Hooks } from "../chat/hooks.ts"
import { HarnessError, LIVE } from "../chat/state.ts"
import { MAIN_CHAT } from "../chat/turns.ts"
import type { Office } from "../daemon/office.ts"
import { strip } from "../perm/redact.ts"
import { InvalidTransition, type QuestionRecord, type SessionRecord, type Store } from "../store/store.ts"
import { InvalidAnswer, checkAnswer } from "./checker.ts"
import { INTERRUPTED } from "./format.ts"

/** The four ways a question is answered (`option`, `text`, `sent_back`, `interrupted`): the store's `answer_kind`. */
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
  #tail: Promise<unknown> = Promise.resolve()

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

  /** Send the discussion back undecided as `by`; a non-blank `note` is the human's last message in it. */
  async sendBack(
    questionId: string,
    note: string,
    { by = null }: { by?: string | null } = {},
  ): Promise<QuestionRecord> {
    const question = this.#open(questionId)
    this.#notHarness(question)
    if (question.source === "ask") {
      throw new HarnessError(422, "cannot_send_back", "a flow's own question can't be sent back")
    }
    return this.#serial(async () => {
      const current = this.#open(questionId)
      if (current.discussion.length === 0 && !current.carried_from) {
        throw new HarnessError(422, "no_discussion", "chat about the question before sending it back")
      }
      if (strip(note)) {
        this.store.updateQuestion(questionId, { discussion: [...current.discussion, { role: "user", text: note }] })
      }
      return this.actor.answer(questionId, null, "sent_back", { by })
    })
  }

  /**
   * Stop the asker from the card: it gets `[interrupted by the user]` with the discussion.
   *
   * A model question in a live main chat is Esc on that chat (the reply stops too) and is credited to no one; any
   * other model question is answered as `by` and its run carries on.
   */
  async stop(questionId: string, { by = null }: { by?: string | null } = {}): Promise<QuestionRecord> {
    const question = this.#open(questionId)
    this.#notHarness(question)
    if (question.source === "ask") throw new HarnessError(422, "cannot_stop", "a flow's own question can't be stopped")
    const asker = this.store.getSession(question.session_id)
    if (question.source === "ask_user" && asker !== undefined && asker.kind === "main" && LIVE.includes(asker.status)) {
      try {
        await this.actor.interrupt(asker.id)
        return this.store.getQuestion(questionId)!
      } catch (error) {
        // Its run is gone: answer the question alone.
        if (!(error instanceof HarnessError)) throw error
      }
    }
    return this.actor.answer(questionId, INTERRUPTED, "interrupted", { by })
  }

  /** Stop carrying an expired question's discussion into this card and its answer. */
  dismissCarried(questionId: string): QuestionRecord {
    this.#open(questionId)
    return this.store.updateQuestion(questionId, { carried_from: null })
  }

  /** Waits for queued card work (a send-back) to finish. */
  async close(): Promise<void> {
    await this.#tail
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

  /** `questionStored`: a new card carries the discussion of the card before it in its session if that one expired. */
  stored(question: QuestionRecord): void {
    const session = this.store.getSession(question.session_id)
    if (session === undefined) return
    // A side chat's turns copy its discussion onto the card once side chats exist.
    if (session.kind === "side") return
    if (this.#isTurn(question)) return
    const earlier = this.store
      .listQuestions({ sessionId: question.session_id })
      .filter((q) => q.id !== question.id && q.created_at <= question.created_at && !this.#isTurn(q))
    const last = earlier.at(-1)
    if (last !== undefined && last.status === "stale" && last.discussion.length > 0) {
      this.store.updateQuestion(question.id, { carried_from: last.id })
    }
  }

  /** `sessionEnded`: an ended or failed run answers nothing more, so its open questions expire. */
  ended(session: SessionRecord): void {
    for (const q of this.store.listQuestions({ sessionId: session.id, status: "open" })) {
      try {
        this.store.setQuestionStatus(q.id, "stale")
      } catch (error) {
        // A store listener may have answered it during this loop.
        if (!(error instanceof InvalidTransition)) throw error
      }
    }
  }

  /** At start, after the actor resumed what it could: expire open questions of sessions with no live run. */
  sweep(): void {
    for (const q of this.store.listQuestions({ status: "open" })) {
      const session = this.store.getSession(q.session_id)
      if (session !== undefined && !LIVE.includes(session.status)) this.ended(session)
    }
  }

  /** Runs `body` after every queued body before it, failed or not, so one send-back's re-check, note and answer
   *  never interleave with another's. */
  #serial<T>(body: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(() => body())
    this.#tail = run.catch(() => undefined)
    return run
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
    // Both chat flows the office runs share the turn path chat/heard.
    return question.source === "ask" && MAIN_CHAT.isTurn(question.node_id)
  }
}

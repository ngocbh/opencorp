/** Question-card actions (answer, chat about this, send back, stop) and the side chats they open. */
import os from "node:os"
import { isDeepStrictEqual } from "node:util"
import { CompanyDefaults, OFFICE, Session, now } from "@opencorp/protocol"
import type { Hooks } from "../chat/hooks.ts"
import type { RunSpec } from "../chat/run_spec.ts"
import { HarnessError, LIVE, notWaiting } from "../chat/state.ts"
import type { Transcript } from "../chat/transcript.ts"
import { loadRepo } from "../company/loader.ts"
import type { Office } from "../daemon/office.ts"
import { strip } from "../perm/redact.ts"
import { InvalidTransition, type QuestionRecord, type SessionRecord, type Store, newId } from "../store/store.ts"
import type { Answers } from "./ask.ts"
import { InvalidAnswer, checkAnswer } from "./checker.ts"
import { INTERRUPTED } from "./format.ts"
import { buildSeed, FIRST_MESSAGE } from "./seed.ts"
import { BACK_HINT, EXIT_WORDS, discussion, isLive, readSeed, writeSeed } from "./side.ts"

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

/** What side chats ask of the session actor besides the card actions: the chat harness has it; a stand-in or the
 *  Codex sessions don't, and their cards have no "Chat about this". */
export interface SideActor extends CardActor {
  /** The office's transcript, which the side chats' discussions are read from. */
  readonly transcript: Pick<Transcript, "messages" | "runningReply">
  /** The answers, for the discussion a card carries from an expired one. */
  readonly answers: Pick<Answers, "carried">
  /** The run spec of `session`; throws `HarnessError` (422) for a missing flow or a refused folder. */
  spec(session: SessionRecord): Promise<RunSpec>
  /** Starts a new run of stored `starting` session `sessionId`; returns its run id. */
  startRun(sessionId: string): Promise<string>
  /** A message from `by` to live session `sessionId`. */
  prompt(sessionId: string, text: string, options?: { by?: string | null }): Promise<string>
  /** Ends live session `sessionId`. */
  end(sessionId: string): Promise<void>
  /** Ends live session `sessionId` with its run's office end reason `why`, when End can't reach it. */
  abandon(sessionId: string, why: string): Promise<void>
}

/** `actor` as a `SideActor`, or undefined when it can't run side chats. */
function sideActor(actor: CardActor): SideActor | undefined {
  const a = actor as Partial<SideActor>
  const can =
    a.transcript !== undefined &&
    a.answers !== undefined &&
    [a.spec, a.startRun, a.prompt, a.end, a.abandon].every((fn) => typeof fn === "function")
  return can ? (actor as SideActor) : undefined
}

const HARNESS_ONLY_ANSWER = "a Codex card takes only an answer; press Esc in the chat to interrupt Codex's turn"

/**
 * What a question card can do, and the side chats behind "Chat about this". `register` wires its hook methods into
 * the actor's hooks.
 *
 * A side chat is a `kind: side` session of the person who asked, in the asker's folder at the asker's pinned
 * commit. Its messages get the seed (kept in its session dir, not on the session) before them until a reply
 * finishes. Its discussion is copied onto the question each time its worker exits and before each answer.
 */
export class Cards {
  readonly office: Office
  readonly actor: CardActor
  readonly store: Store
  /** Send-backs and discussion copies, one at a time, so a copy can't replace a send-back's note before the answer
   *  lands. */
  #discussion: Promise<unknown> = Promise.resolve()
  /** Side chat opens, one at a time, so a question gets one side session. Its own queue: an open waits on the
   *  harness, which a copy must not wait behind. */
  #sides: Promise<unknown> = Promise.resolve()

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
    this.snapshot(question)
    return this.actor.answer(questionId, value, kind, { by })
  }

  /**
   * "Chat about this": sends `text` from `by` to the question's side session, starting it if it has none and
   * starting a new run of it if it ended or failed (whoever reopens it is in it now). Answers 501 when the actor
   * can't run side chats, 422 `refused` for the exit command, 422 for a missing flow or a refused folder (nothing is
   * stored), and 409 `not_open` when the question closed while the side chat started (the side chat is ended).
   */
  async openSide(questionId: string, text: string, { by = null }: { by?: string | null } = {}): Promise<SessionRecord> {
    const question = this.#open(questionId)
    this.#notHarness(question)
    const actor = sideActor(this.actor)
    if (actor === undefined) throw new HarnessError(501, "not_implemented", "this office has no side chats")
    const refusal = this.refuseExit(undefined, text)
    if (refusal) throw new HarnessError(422, "refused", refusal)
    const side = await this.#serialSide(async () => {
      const current = this.#open(questionId)
      const stored = current.side_session_id ? this.store.getSession(current.side_session_id) : undefined
      if (stored === undefined) return this.#createSide(actor, current, by)
      if (!isLive(stored)) {
        const reopened = { ...stored, opened_by: by ?? stored.opened_by }
        // Refuses a missing flow or folder before anything is stored.
        await actor.spec(reopened)
        this.store.updateSession(stored.id, { ...notWaiting("starting"), opened_by: reopened.opened_by })
        await actor.startRun(stored.id)
      }
      return stored
    })
    if (this.store.getQuestion(questionId)!.status !== "open") {
      try {
        await actor.end(side.id)
      } catch (error) {
        // Its run is already gone.
        if (!(error instanceof HarnessError)) throw error
      }
      throw new HarnessError(409, "not_open", `question ${questionId} is no longer open`)
    }
    await actor.prompt(side.id, text, { by })
    return this.store.getSession(side.id)!
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
      const current = this.snapshot(this.#open(questionId))
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
    this.snapshot(question)
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

  /** Copies the side session's discussion onto `question`; returns the question as stored. */
  snapshot(question: QuestionRecord): QuestionRecord {
    const actor = sideActor(this.actor)
    if (!question.side_session_id || actor === undefined) return question
    const entries = discussion(this.store, actor.transcript, question.side_session_id)
    if (isDeepStrictEqual(entries, question.discussion)) return question
    return this.store.updateQuestion(question.id, { discussion: entries })
  }

  /** Waits for queued card work (send-backs, discussion copies and side chat opens) to finish. */
  async close(): Promise<void> {
    await Promise.all([this.#discussion, this.#sides])
  }

  /** `answerCheck`: refuse an answer that doesn't fit its card. */
  check(question: QuestionRecord, answer: unknown, kind: AnswerKind): string | null {
    try {
      checkAnswer(question, answer, kind)
    } catch (error) {
      if (error instanceof InvalidAnswer) return error.message
      throw error
    }
    return null
  }

  /** `promptCheck`: only the office ends a side chat (`session` undefined is one being opened). */
  refuseExit(session: SessionRecord | undefined, text: string): string | null {
    if ((session === undefined || session.kind === "side") && EXIT_WORDS.has(text.trim().toLowerCase())) {
      return BACK_HINT
    }
    return null
  }

  /**
   * `turnContext`: a side session's message gets the seed before it until a reply finishes (`first`), so a first
   * reply that failed sends it again, and a reopened side chat, whose history has it, never does.
   */
  firstTurn(session: SessionRecord, _text: string, { first }: { first: boolean }): string | null {
    if (session.kind !== "side" || !first) return null
    const seed = readSeed(this.office.paths.sessionDir(session.id))
    if (seed === null) return null
    // The context and the message go as two text parts (Ollama joins them with "\n"), so the heading ends one
    // newline short and the joined text is `firstMessage(seed, text)`.
    return `${seed}\n\n${FIRST_MESSAGE.slice(0, -1)}`
  }

  /** `workerExited`: a side session's worker exits after each run call, so its open card copies the discussion. */
  sideExited(session: SessionRecord): Promise<void> | undefined {
    const questionId = session.kind === "side" ? session.question_id : null
    if (!questionId) return undefined
    return this.#serial(async () => {
      const question = this.store.getQuestion(questionId)
      if (question?.status === "open") this.snapshot(question)
    })
  }

  /** `questionStored`: a new card carries the discussion of the card before it in its session if that one expired. */
  stored(question: QuestionRecord): void {
    const session = this.store.getSession(question.session_id)
    if (session === undefined) return
    // A side run asks nothing.
    if (session.kind === "side") return
    const earlier = this.store
      .listQuestions({ sessionId: question.session_id })
      .filter((q) => q.id !== question.id && q.created_at <= question.created_at)
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

  /** Runs `body` on the discussion queue, after every body queued before it, failed or not, so one send-back's
   *  re-check, note and answer never interleave with another's or with a discussion copy. */
  #serial<T>(body: () => Promise<T>): Promise<T> {
    const run = this.#discussion.then(() => body())
    this.#discussion = run.catch(() => undefined)
    return run
  }

  /** Runs `body` on the side chat queue, after every body queued before it, failed or not. */
  #serialSide<T>(body: () => Promise<T>): Promise<T> {
    const run = this.#sides.then(() => body())
    this.#sides = run.catch(() => undefined)
    return run
  }

  /** Stores `question`'s side session, opened by `by`, with its seed, and starts it. Refused 409 `not_open` when
   *  the question has no session; its spec is built before anything is stored, so a missing flow or a refused
   *  folder stores nothing. */
  async #createSide(actor: SideActor, question: QuestionRecord, by: string | null): Promise<SessionRecord> {
    const asker = this.store.getSession(question.session_id)
    if (asker === undefined) throw new HarnessError(409, "not_open", `question ${question.id} has no session`)
    const repo = loadRepo(await this.office.git.pin(asker.repo_commit))
    const defaults = repo.company?.defaults ?? CompanyDefaults.parse({})
    const seed = buildSeed(this.store, actor.transcript, repo, question, {
      maxChars: defaults.side_seed_max_chars,
      carried: actor.answers.carried(question),
    })
    const t = now()
    const side = Session.parse({
      id: newId(),
      person: question.asker,
      harness: "composer",
      office: os.hostname(),
      cwd: asker.cwd,
      repo_commit: asker.repo_commit,
      status: "starting",
      kind: "side",
      question_id: question.id,
      work_item_id: null,
      cost_cap_usd: defaults.side_chat_cost_cap_usd,
      opened_by: by,
      connection: asker.connection ?? OFFICE,
      model: asker.model,
      model_note: null,
      harness_session_id: null,
      parent_session_id: null,
      created_at: t,
      updated_at: t,
    })
    await actor.spec(side)
    writeSeed(this.office.paths.sessionDir(side.id), seed)
    const created = this.store.createSession(side)
    this.store.updateQuestion(question.id, { side_session_id: side.id })
    await actor.startRun(side.id)
    return created
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
}

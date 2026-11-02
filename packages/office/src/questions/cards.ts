/** Question-card actions (answer, chat about this, send back, stop) and the side chats they open. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { CompanyDefaults, OFFICE, Session, now } from "@opencorp/protocol"
import type { Hooks } from "../chat/hooks.ts"
import type { RunSpec } from "../chat/run_spec.ts"
import { HarnessError, LIVE, SETTLED, notWaiting } from "../chat/state.ts"
import type { Transcript } from "../chat/transcript.ts"
import { loadRepo } from "../company/loader.ts"
import type { Office } from "../daemon/office.ts"
import { strip } from "../perm/redact.ts"
import { CARD_CLOSED, OFFICE_STOPPED } from "../runs/outcomes.ts"
import { InvalidTransition, type QuestionRecord, type SessionRecord, type Store, newId } from "../store/store.ts"
import { errorName } from "../worker/rpc.ts"
import type { Answers } from "./ask.ts"
import { InvalidAnswer, checkAnswer } from "./checker.ts"
import { INTERRUPTED } from "./format.ts"
import { buildSeed, FIRST_MESSAGE } from "./seed.ts"
import { BACK_HINT, EXIT_WORDS, discussion, isLive, readSeed, writeSeed } from "./side.ts"

/** The four ways a question is answered (`option`, `text`, `sent_back`, `interrupted`): the store's `answer_kind`. */
export type AnswerKind = NonNullable<QuestionRecord["answer_kind"]>

/** What the cards ask of the session actor: the chat harness or the Codex sessions. */
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
   *  `HarnessError` when the session has no run to stop. A card's stop names its `question`: refused 409
   *  `not_open` unless it is open with no other interrupt under way, and 409 `ending` while the session ends. */
  interrupt(sessionId: string, options?: { question?: string | null }): Promise<void>
}

/** What side chats ask of the session actor besides the card actions: the chat harness has it; a stand-in or the
 *  Codex sessions don't, and their cards have no "Chat about this". */
export interface SideActor extends CardActor {
  /** The office's transcript, which the side chats' discussions and seeds are read from. */
  readonly transcript: Pick<Transcript, "messages" | "runningReply" | "refresh">
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
  /** Where the side chats' warnings go. */
  readonly log: (line: string) => void
}

/** `actor` as a `SideActor`, or undefined when it can't run side chats. */
function sideActor(actor: CardActor): SideActor | undefined {
  const a = actor as Partial<SideActor>
  const can =
    a.transcript !== undefined &&
    a.answers !== undefined &&
    [a.spec, a.startRun, a.prompt, a.end, a.abandon, a.log].every((fn) => typeof fn === "function")
  return can ? (actor as SideActor) : undefined
}

const HARNESS_ONLY_ANSWER = "a Codex card takes only an answer; press Esc in the chat to interrupt Codex's turn"

/**
 * What a question card can do, and the side chats behind "Chat about this". `register` wires its hook methods into
 * the actor's hooks.
 *
 * A side chat is a `kind: side` session of the person who asked, in the asker's folder at the asker's pinned
 * commit. Its messages get the seed (kept in its session dir, not on the session) before them until a reply
 * finishes. Its discussion is copied onto the question each time its worker exits and before each answer. It ends
 * when its question leaves `open`.
 */
export class Cards {
  readonly office: Office
  readonly actor: CardActor
  readonly store: Store
  /** Send-backs and discussion copies, one at a time, so a copy can't replace a send-back's note before the answer
   *  lands. */
  #discussion: Promise<unknown> = Promise.resolve()
  /** Side chat opens, one at a time per question, so a question gets one side session; by question id. Its own
   *  queues: an open waits on the harness (a reopen on its last run's cancel), which a copy or another card's open
   *  must not wait behind. */
  readonly #sides = new Map<string, Promise<unknown>>()
  /** Side chat ends, one at a time. Its own queue: an end waits on the harness, which a send-back or an open may be
   *  waiting on too. */
  #closing: Promise<unknown> = Promise.resolve()
  readonly #unlisten: () => void
  /** The questions a stop is under way for: a second stop of one is refused. */
  readonly #stopping = new Set<string>()

  constructor(office: Office, actor: CardActor) {
    this.office = office
    this.actor = actor
    this.store = office.store
    // A store listener must not wait: the end goes on the closing queue.
    this.#unlisten = this.store.addListener((event) => {
      if (event.type !== "question.updated") return
      const question = event.data as QuestionRecord
      if (question.side_session_id && question.status !== "open") this.#close(question.side_session_id, question)
    })
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
    const side = await this.#serialSide(questionId, async () => {
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

  /** Send the discussion back undecided as `by`; a non-blank `note` is the human's last message in it. A note that
   *  isn't well-formed text is refused `422 invalid_answer`: the discussion goes to the run with the answer. */
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
    if (!note.isWellFormed()) throw new HarnessError(422, "invalid_answer", "the note must be valid text")
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
   * A model question in a live main chat is Esc on that chat (the reply stops too) and is credited to no one; when
   * the interrupt leaves the question open (nothing ran to close it), or the chat has no run to interrupt, it is
   * answered as for any other model question: as `by`, and its run carries on. Refused 409 `not_open` while another
   * stop of it, an answer that came first or another Esc is under way, and 409 `ending` while its chat ends.
   */
  async stop(questionId: string, { by = null }: { by?: string | null } = {}): Promise<QuestionRecord> {
    const question = this.#open(questionId)
    this.#notHarness(question)
    if (question.source === "ask") throw new HarnessError(422, "cannot_stop", "a flow's own question can't be stopped")
    if (this.#stopping.has(questionId)) {
      throw new HarnessError(409, "not_open", `question ${questionId} is being stopped`)
    }
    this.#stopping.add(questionId)
    try {
      this.snapshot(question)
      const asker = this.store.getSession(question.session_id)
      const main = asker !== undefined && asker.kind === "main" && LIVE.includes(asker.status)
      if (question.source === "ask_user" && main) {
        try {
          await this.actor.interrupt(asker.id, { question: questionId })
        } catch (error) {
          // Its run is gone: answer the question alone. An answer or End that came first wins.
          if (!(error instanceof HarnessError) || error.code === "not_open" || error.code === "ending") throw error
        }
        const current = this.store.getQuestion(questionId)!
        if (current.status !== "open") {
          if (current.answer_kind === "interrupted" && current.status !== "stale") return current
          throw new HarnessError(409, "not_open", `question ${questionId} is ${current.status}`)
        }
      }
      return await this.actor.answer(questionId, INTERRUPTED, "interrupted", { by })
    } finally {
      this.#stopping.delete(questionId)
    }
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

  /** Stops reacting to question changes, and waits for queued card work (send-backs, discussion copies, side chat
   *  opens and ends) to finish. */
  async close(): Promise<void> {
    this.#unlisten()
    await Promise.all([this.#discussion, ...this.#sides.values(), this.#closing])
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

  /** `callEnded`: after each run call of a side session, its open card copies the discussion. */
  sideCallEnded(session: SessionRecord): Promise<void> | undefined {
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
    // A side run asks nothing.
    if (session === undefined || session.kind === "side") return
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

  /**
   * At start, after the actor resumed what it could: expire open questions of sessions with no live run, and end
   * side sessions whose question is closed. A side session still `starting` is ended at once, in the store: no
   * `openSide` runs at start, so an office stop came inside its start, before its run showed a turn, a question or a
   * reply (one whose first reply was seen running is busy, and restore resumed it). Restore may still have resumed
   * its run: it reads `starting` until the resumed run shows one. Its run, when stored with no log (its worker never
   * started it), ends as the office stopped, with no end time.
   */
  sweep(): void {
    for (const q of this.store.listQuestions({ status: "open" })) {
      const session = this.store.getSession(q.session_id)
      if (session !== undefined && !LIVE.includes(session.status)) this.ended(session)
    }
    for (const side of this.store.listSessions({ kind: "side", status: [...SETTLED] })) {
      const question = side.question_id ? this.store.getQuestion(side.question_id) : undefined
      if (side.status === "starting") {
        if (question?.status === "stale") this.snapshot(question)
        this.ended(this.store.updateSession(side.id, notWaiting("ended")))
        const runId = side.run_ids.at(-1)
        // A run with a log keeps whatever yian made of it: an office end reason would hide yian's outcome.
        if (runId !== undefined && !fs.existsSync(path.join(this.office.paths.runs, runId, "log.jsonl"))) {
          this.store.sweepRuns([runId], OFFICE_STOPPED)
        }
      } else if (question === undefined || question.status !== "open") {
        this.#close(side.id, question)
      }
    }
  }

  /** Runs `body` on the discussion queue, after every body queued before it, failed or not, so one send-back's
   *  re-check, note and answer never interleave with another's or with a discussion copy. */
  #serial<T>(body: () => Promise<T>): Promise<T> {
    const run = this.#discussion.then(() => body())
    this.#discussion = run.catch(() => undefined)
    return run
  }

  /** Ends side session `sideId` of `question` (undefined when it is gone) on the closing queue; an error that isn't
   *  the harness's refusal is logged by its type. */
  #close(sideId: string, question: QuestionRecord | undefined): void {
    const actor = sideActor(this.actor)
    if (actor === undefined) return
    this.#closing = this.#closing.then(() =>
      this.#closeSide(actor, sideId, question).catch((error) => {
        actor.log(`side session ${sideId} can't be ended (${errorName(error)})`)
      }),
    )
  }

  /**
   * Ends side session `sideId` because `question` closed: an expired card keeps its discussion; End reaches a live
   * run, and when it can't, the session ends with its run's end reason `CARD_CLOSED`. End on a side chat still
   * `starting` waits behind its start and ends the new run; one the harness holds no start of answers 409 and is
   * left alone.
   */
  async #closeSide(actor: SideActor, sideId: string, question: QuestionRecord | undefined): Promise<void> {
    if (question?.status === "stale") {
      const current = this.store.getQuestion(question.id)
      if (current !== undefined) this.snapshot(current)
    }
    const side = this.store.getSession(sideId)
    if (!isLive(side)) return
    try {
      await actor.end(sideId)
    } catch (error) {
      if (!(error instanceof HarnessError)) throw error
      // A stopping office leaves it to the next start's sweep; a failed wake for the end has failed it; a run that
      // finished on its own stored its end; a session `starting` with no start in this harness has no run to end.
      const current = this.store.getSession(sideId)
      if (error.code === "stopping" || !isLive(current) || current!.status === "starting") return
      actor.log(`side session ${sideId} has no live run to end`)
      try {
        await actor.abandon(sideId, CARD_CLOSED)
      } catch (failure) {
        // It ended or stopped meanwhile.
        if (!(failure instanceof HarnessError)) throw failure
      }
    }
  }

  /** Runs `body` on question `questionId`'s side chat queue, after every body queued on it before, failed or not. */
  #serialSide<T>(questionId: string, body: () => Promise<T>): Promise<T> {
    const run = (this.#sides.get(questionId) ?? Promise.resolve()).then(() => body())
    const tail = run.catch(() => undefined)
    this.#sides.set(questionId, tail)
    // Dropped once idle, so the map holds only questions with an open queued or running.
    void tail.then(() => {
      if (this.#sides.get(questionId) === tail) this.#sides.delete(questionId)
    })
    return run
  }

  /** Stores `question`'s side session, opened by `by`, with its seed, and starts it. Refused 409 `not_open` when
   *  the question has no session; its spec is built before anything is stored, so a missing flow or a refused
   *  folder stores nothing. A refused spec, or a seed or session that can't be stored, removes the session dir. */
  async #createSide(actor: SideActor, question: QuestionRecord, by: string | null): Promise<SessionRecord> {
    const asker = this.store.getSession(question.session_id)
    if (asker === undefined) throw new HarnessError(409, "not_open", `question ${question.id} has no session`)
    const repo = loadRepo(await this.office.git.pin(asker.repo_commit))
    const defaults = repo.company?.defaults ?? CompanyDefaults.parse({})
    // Read on first without holding the event loop, so the seed's synchronous read takes only what was added since.
    await actor.transcript.refresh(asker.run_ids)
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
    const dir = this.office.paths.sessionDir(side.id)
    let created: SessionRecord
    try {
      await actor.spec(side)
      writeSeed(dir, seed)
      created = this.store.createSession(side)
    } catch (error) {
      // The spec made its tmp dir there, and the seed may be in it; the id is new, so nothing else uses the dir.
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch (failure) {
        actor.log(`side session ${side.id}'s folder can't be removed (${errorName(failure)})`)
      }
      throw error
    }
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

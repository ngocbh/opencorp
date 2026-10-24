/** The office side of a run's `ask_user`, and storing questions until they are answered. */
import { type DiscussionEntry, Question, now, validationMessage } from "@opencorp/protocol"
import {
  DuplicateKey,
  InvalidTransition,
  NotFound,
  newId,
  type QuestionRecord,
  type SessionRecord,
  type Store,
  type WorkItemRecord,
} from "../store/store.ts"
import type { AskRequest } from "../worker/rpc.ts"
import { formatAnswer } from "./format.ts"
import { normalizeOptions } from "./normalize.ts"

/** Store an open question (with `workItem`, if given), wait until it is answered, and return it answered. An
 *  aborted `signal` stops the wait. */
export type OnQuestion = (
  question: QuestionRecord,
  options?: { workItem?: WorkItemRecord; signal?: AbortSignal },
) => Promise<QuestionRecord>

/** The discussion an answered question carries over from an earlier, expired one. */
export type Carried = (question: QuestionRecord) => Iterable<DiscussionEntry>

/** `Answers` was closed before the question was answered. */
export class AnswersClosed extends Error {
  override name = "AnswersClosed"
}

/** The question went stale (its run restarted or was abandoned) before anyone answered. */
export class QuestionExpired extends Error {
  override name = "QuestionExpired"
}

/**
 * Return a run's `ask_user` handler: the six `ASK_KEYS` in, the answer out.
 *
 * A call with a `node_id` is a `human_input` node: its pages and answer schema are kept, and it gets the answer
 * value. A call without one is the model's: its options are normalized (`names` are the asker's names, for dropping
 * `Stop <name>`), and it gets the answer as text. The question is asked by `session.person` on
 * `session.work_item_id`. A request that doesn't make a valid question rejects with a `TypeError` naming only the
 * bad fields.
 */
export function makeAskUser(
  session: SessionRecord,
  runId: string,
  onQuestion: OnQuestion,
  options: { names?: Iterable<string>; carried?: Carried } = {},
): (request: AskRequest) => Promise<unknown> {
  const names = [...(options.names ?? [])]
  const carried = options.carried
  return async (request) => {
    const nodeId = request.node_id ?? null
    const fields = nodeId
      ? { source: "human_input", questions: request.questions, answer_schema: request.answer_schema ?? [] }
      : { source: "ask_user", options: normalizeOptions(request.options, { names }) }
    const t = now()
    const data = {
      id: newId(),
      session_id: session.id,
      run_id: runId,
      node_id: nodeId,
      asker: session.person,
      work_item_id: session.work_item_id,
      title: request.title,
      question: request.question || "",
      status: "open",
      created_at: t,
      updated_at: t,
      ...fields,
    }
    const parsed = Question.safeParse(data)
    // Only validationMessage's text leaves: the ZodError and its issues can quote the request's values.
    if (!parsed.success) throw new TypeError(validationMessage(Question, parsed.error, data))
    const answered = await onQuestion(parsed.data)
    return formatAnswer(answered, carried ? carried(answered) : [])
  }
}

/** Store questions and make callers wait until each is answered; one store listener wakes them all. Answers written
 *  by another process are not seen until the question's next event: only the daemon writes the store. */
export class Answers {
  readonly store: Store
  #log: (line: string) => void
  #closed = false
  /** Question id -> the wakers of the calls waiting on it. */
  #waiting = new Map<string, Set<() => void>>()
  #remove: () => void

  /** `log` (default: `console.error`) gets a line when an expired question's work item can't be cancelled. */
  constructor(store: Store, options: { log?: (line: string) => void } = {}) {
    this.store = store
    this.#log = options.log ?? ((line) => console.error(line))
    this.#remove = store.addListener((event) => {
      if (event.type !== "question.updated") return
      for (const wake of [...(this.#waiting.get(event.subject_id) ?? [])]) wake()
    })
  }

  /** How many question ids have a waiting call now. */
  get waiting(): number {
    return this.#waiting.size
  }

  /** Stop listening to the store; any later `ask` throws `AnswersClosed`. */
  close(): void {
    this.#remove()
    this.#closed = true
  }

  /**
   * Store `question` and return it once answered, marked `consumed`. The question is stored before this returns its
   * promise.
   *
   * `workItem`, if given, is stored in the same transaction as the question, and set to `cancelled` if the question
   * goes stale. A `human_input` asked again for the same run and node (after a restart) reuses the question already
   * stored, and its answer if it has one. An aborted `signal` rejects with its reason and leaves the question and its
   * work item as they are.
   *
   * Rejects with `QuestionExpired` if the question went stale first, `AnswersClosed` if this was closed first.
   */
  async ask(
    question: QuestionRecord,
    options: { workItem?: WorkItemRecord; signal?: AbortSignal } = {},
  ): Promise<QuestionRecord> {
    const { signal } = options
    let workItem = options.workItem
    signal?.throwIfAborted()
    if (this.#closed) throw new AnswersClosed("answers is closed")
    let qid = question.id
    try {
      this.store.transaction(() => {
        if (workItem) this.store.createWorkItem(workItem)
        this.store.addQuestion(question)
      })
    } catch (error) {
      const stored =
        error instanceof DuplicateKey && question.node_id !== null
          ? this.store.getQuestionByNode(question.run_id, question.node_id)
          : undefined
      if (!stored) throw error
      workItem = undefined // rolled back with the question
      qid = stored.id
    }
    return this.#answered(qid, workItem, signal)
  }

  /** The discussion of the expired question `question` carries over, if any. */
  carried(question: QuestionRecord): DiscussionEntry[] {
    const earlier = question.carried_from ? this.store.getQuestion(question.carried_from) : undefined
    return earlier ? [...earlier.discussion] : []
  }

  async #answered(qid: string, workItem: WorkItemRecord | undefined, signal?: AbortSignal): Promise<QuestionRecord> {
    let current = await this.#settled(qid, signal)
    if (current.status === "stale") {
      if (workItem) this.#cancel(qid, workItem)
      throw new QuestionExpired(`question ${qid} expired before it was answered`)
    }
    if (current.status === "answered") {
      try {
        current = this.store.setQuestionStatus(qid, "consumed")
      } catch (error) {
        if (!(error instanceof InvalidTransition)) throw error
        current = this.#question(qid) // consumed by another call meanwhile
      }
    }
    return current
  }

  /** Wait until question `qid` is no longer open and return it. */
  async #settled(qid: string, signal?: AbortSignal): Promise<QuestionRecord> {
    for (;;) {
      // The waker is registered before the read, so an answer that lands right after the read still wakes us.
      let wake!: () => void
      const woken = new Promise<void>((resolve) => (wake = resolve))
      let wakes = this.#waiting.get(qid)
      if (!wakes) this.#waiting.set(qid, (wakes = new Set()))
      wakes.add(wake)
      signal?.addEventListener("abort", wake)
      try {
        // Checked before the read, so an aborted call never consumes an answer that already landed.
        signal?.throwIfAborted()
        const current = this.#question(qid)
        if (current.status !== "open") return current
        if (this.#closed) throw new AnswersClosed(`stopped waiting for question ${qid}`)
        await woken
      } finally {
        wakes.delete(wake)
        if (!wakes.size) this.#waiting.delete(qid)
        signal?.removeEventListener("abort", wake)
      }
    }
  }

  #question(qid: string): QuestionRecord {
    const found = this.store.getQuestion(qid)
    if (!found) throw new NotFound(`no question ${qid}`)
    return found
  }

  #cancel(qid: string, workItem: WorkItemRecord): void {
    // Logged, not thrown: the caller is already throwing QuestionExpired. Only the error's name: its message may
    // hold paths or values.
    try {
      this.store.updateWorkItem(workItem.id, { status: "cancelled" })
    } catch (error) {
      const name = error instanceof Error ? error.name : typeof error
      this.#log(`could not cancel the work item of expired question ${qid}: ${name}`)
    }
  }
}

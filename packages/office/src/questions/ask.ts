/** The office side of a run's `ask_user`: one stored question per yian call, answered later, and the endings of a
 *  call that closes before its answer. */
import type { PendingCall } from "@ngocbh/yian/run"
import { pending } from "@ngocbh/yian/tools"
import { type DiscussionEntry, Question, now, validationMessage } from "@opencorp/protocol"
import { InvalidTransition, newId, type QuestionRecord, type SessionRecord, type Store, type WorkItemRecord } from "../store/store.ts"
import { strip } from "../perm/redact.ts"
import { AskRefused, type AskRequest, errorName } from "../worker/rpc.ts"
import { formatAnswer, INTERRUPTED } from "./format.ts"
import { normalizeOptions } from "./normalize.ts"

/** Store `question` (with `workItem`, in the same transaction) unless a question is stored for its `call_id`; return
 *  the stored question. */
export type OnQuestion = (question: QuestionRecord, options?: { workItem?: WorkItemRecord }) => QuestionRecord

/** The discussion an answered question carries over from an earlier, expired one. */
export type Carried = (question: QuestionRecord) => Iterable<DiscussionEntry>

/**
 * What a question handler returns for its stored `question`: yian's `pending()` while it is open, and the formatted
 * answer (`formatAnswer` with `carried`) once it is `answered` or `consumed`, so a call re-invoked after its reply
 * was lost still gets it. Throws an `Error` naming only the question id if the question expired.
 */
export function reply(question: QuestionRecord, carried?: Carried): unknown {
  if (question.status === "open") return pending()
  if (question.status === "stale") throw new Error(`question ${question.id} expired before it was answered`)
  return formatAnswer(question, carried ? carried(question) : [])
}

/**
 * Return a run's question handler: the six `ASK_KEYS` and the yian call id in, `reply` out.
 *
 * One question per call id: `onQuestion` stores the first call's question, and a call again with that id reuses it,
 * so an open one replies pending and an answered one returns its answer. The answer goes back to yian by `complete`
 * on the call id, or inline when the call comes again.
 *
 * A call with a `node_id` is a flow's `ask` node: its pages and answer schema are kept, and it gets the answer value.
 * Each page that is a plain object keeps only `question`, `header`, `options` (default `[]`), `multi_select` (or
 * yian's `multiSelect`, default `false`) and `secret`; other keys are dropped. A call without one is the model's: its
 * options are normalized (`names` are the asker's names, for dropping `Stop <name>`), and it gets the answer as text.
 * The question is asked by `session.person` on `session.work_item_id`. A model's call whose question is missing or
 * blank, or whose question or options aren't well-formed text, rejects with `AskRefused`, which the model reads as
 * the call's result; a flow's `ask` node may have an empty question, since its pages carry the text. A request that
 * doesn't make a valid question rejects with a `TypeError` naming only the bad fields.
 */
export function makeAskUser(
  session: SessionRecord,
  runId: string,
  onQuestion: OnQuestion,
  options: { names?: Iterable<string>; carried?: Carried } = {},
): (request: AskRequest, callId: string) => Promise<unknown> {
  const names = [...(options.names ?? [])]
  const carried = options.carried
  return async (request, callId) => {
    const nodeId = request.node_id ?? null
    const fields = nodeId
      ? { source: "ask", questions: pages(request.questions), answer_schema: request.answer_schema ?? [] }
      : { source: "ask_user", options: normalizeOptions(request.options, { names }) }
    if (!nodeId) refuseModelQuestion(request.question, fields.options!)
    const t = now()
    const data = {
      id: newId(),
      session_id: session.id,
      run_id: runId,
      node_id: nodeId,
      call_id: callId,
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
    return reply(onQuestion(parsed.data), carried)
  }
}

/** Throws `AskRefused` for a model question with no text to show, or with text that isn't well-formed (a lone
 *  surrogate); neither message quotes a value. */
function refuseModelQuestion(question: unknown, options: readonly string[]): void {
  if (typeof question !== "string" || strip(question) === "") {
    throw new AskRefused("ask_user question is blank: write the question to ask the user")
  }
  if (!question.isWellFormed() || !options.every((option) => option.isWellFormed())) {
    throw new AskRefused("ask_user question and options must be valid text")
  }
}

/** An `ask` node's pages in the protocol's form: yian hands them parsed, with `multiSelect`. Anything but an array
 *  of plain objects is left for validation to refuse. */
function pages(questions: unknown): unknown {
  if (!Array.isArray(questions)) return questions
  return questions.map((page: unknown) => {
    if (!isPlainObject(page)) return page
    const { question, header, options, multi_select, multiSelect, secret } = page
    const kept = { question, header, options: options ?? [], multi_select: multi_select ?? multiSelect ?? false }
    return secret === undefined ? kept : { ...kept, secret }
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Store each yian call's question once, and close it when the call closes first.
 *
 * Nothing here waits: yian holds the wait, and the answer goes back by `complete`. One store listener, kept for the
 * store's life, ends an `ask_manager` question's work item whenever its question is answered (`done`, resolved by
 * whoever answered) or goes stale (`cancelled`), whoever stores that. An item already `done` or `cancelled`, or
 * missing, is left as it is, where Python overwrote it. The item's update is its own commit after the question's, so
 * a crash between leaves the item open; an office stop writes nothing, so the item stays open too. The listener
 * settles the item again when the question is `consumed`, which closes an item a crash left open; so an item reopened
 * by hand between the answer and `consumed` is closed again, where Python closed it once.
 */
export class Answers {
  readonly store: Store
  readonly #log: (line: string) => void

  /** `log` (default: `console.error`) gets a line when an `ask_manager` question's work item can't be updated, or a
   *  question can't be stored by `reconcile`. */
  constructor(store: Store, options: { log?: (line: string) => void } = {}) {
    this.store = store
    this.#log = options.log ?? ((line) => console.error(line))
    store.addListener((event) => {
      if (event.type !== "question.updated") return
      const question = event.data as QuestionRecord
      if (question.source !== "ask_manager" || !question.work_item_id) return
      const ended = question.status === "answered" || question.status === "consumed"
      if (!ended && question.status !== "stale") return
      try {
        const item = store.getWorkItem(question.work_item_id)
        if (!item || item.status === "done" || item.status === "cancelled") return
        store.updateWorkItem(
          item.id,
          ended ? { status: "done", resolved_by: question.answered_by } : { status: "cancelled" },
        )
      } catch (error) {
        // Only the error's name: its message may hold paths or values.
        this.#log(`could not settle the work item of question ${question.id}: ${errorName(error)}`)
      }
    })
  }

  /**
   * Store `question` and return it, unless a question is already stored for its `call_id`: then return that one,
   * marked `consumed` if it was `answered` (its answer goes back inline), and don't store `workItem`.
   *
   * `workItem`, if given, is stored in the same transaction as the question. Throws a `TypeError` unless the call id
   * is of the question's own run (it starts with `${run_id}/`), or if the question stored for it is another run's.
   */
  ask(question: QuestionRecord, { workItem }: { workItem?: WorkItemRecord } = {}): QuestionRecord {
    const callId = question.call_id
    if (typeof callId !== "string" || !callId.startsWith(`${question.run_id}/`)) {
      throw new TypeError("a question's call id must name its run")
    }
    return this.store.transaction(() => {
      const stored = this.store.getQuestionByCall(callId)
      if (stored && stored.run_id !== question.run_id) throw new TypeError("a question's call id must name its run")
      if (stored) return stored.status === "answered" ? this.store.setQuestionStatus(stored.id, "consumed") : stored
      if (workItem) this.store.createWorkItem(workItem)
      return this.store.addQuestion(question)
    })
  }

  /** The discussion of the expired question `question` carries over, if any. */
  carried(question: QuestionRecord): DiscussionEntry[] {
    const earlier = question.carried_from ? this.store.getQuestion(question.carried_from) : undefined
    return earlier ? [...earlier.discussion] : []
  }

  /**
   * Close the question of yian call `callId` of run `runId`, which closed with `reason` (`crashed`, `interrupted`,
   * `timed_out`, `cancelled` or `failed`) before it was answered; return the question.
   *
   * An `interrupted` `ask_user` or `ask_manager` question is answered `INTERRUPTED` (kind `interrupted`, by no one)
   * and marked `consumed`, since no call will take the answer. Any other reason, or an interrupted flow `ask`, makes
   * it `stale`: a `timed_out` call closes its card too. A question no longer open is returned unchanged. Undefined
   * unless `callId` is of `runId` and a question of `runId` is stored for it.
   */
  closedCall(runId: string, callId: string, reason: string): QuestionRecord | undefined {
    if (!callId.startsWith(`${runId}/`)) return undefined
    return this.store.transaction(() => {
      const question = this.store.getQuestionByCall(callId)
      if (!question || question.run_id !== runId) return undefined
      if (question.status !== "open") return question
      if (reason === "interrupted" && (question.source === "ask_user" || question.source === "ask_manager")) {
        this.store.answerQuestion(question.id, INTERRUPTED, "interrupted", null)
        return this.store.setQuestionStatus(question.id, "consumed")
      }
      return this.store.setQuestionStatus(question.id, "stale")
    })
  }

  /**
   * Settle a waiting run's questions against yian's open calls (`pendingCalls(log)`): an open question whose call
   * isn't listed goes stale; a listed call with no question is stored through `handlers`, as a live call would be.
   * Call only for a `waiting` run while no worker runs it (a crashed run's questions may belong to calls yian hasn't
   * recorded yet, which a resume re-invokes). Call ids outside `${runId}/` are skipped. An `answered` question whose
   * call yian settled is left as it is: the actor sends its answer again, which settles it. Only question calls
   * (`ask`, `ask_user`, `ask_manager`) are rebuilt: a pending step names a tool, and re-running any other tool from
   * it would skip the job's grant check.
   *
   * A TOOL `ask` call's recorded arguments are the node's inputs only, so its rebuilt question has no title and no
   * answer schema. A handler that throws is logged by the call id and the error's name, and the rest go on.
   */
  async reconcile(
    runId: string,
    calls: readonly PendingCall[],
    handlers: {
      askUser: (request: AskRequest, callId: string) => unknown
      askManager?: (args: Record<string, unknown>, callId: string) => unknown
    },
  ): Promise<void> {
    const own = calls.filter((call) => call.callId.startsWith(`${runId}/`))
    const listed = new Set(own.map((call) => call.callId))
    for (const question of this.store.listQuestions({ runId, status: "open" })) {
      if (question.call_id === null || listed.has(question.call_id)) continue
      try {
        this.store.setQuestionStatus(question.id, "stale")
      } catch (error) {
        // Answered or closed since it was listed: it is no longer open, which is all this step wants.
        if (!(error instanceof InvalidTransition)) throw error
      }
    }
    for (const call of own) {
      if (this.store.getQuestionByCall(call.callId)) continue
      const args: Record<string, unknown> = call.arguments ?? {}
      try {
        if (call.tool === "ask_user") {
          await handlers.askUser(
            {
              question: args.question ?? null,
              options: args.options ?? null,
              questions: null,
              answer_schema: null,
              title: null,
              node_id: null,
            },
            call.callId,
          )
        } else if (call.tool === "ask") {
          await handlers.askUser(
            {
              question: args.prompt ?? "",
              questions: args.questions ?? args.__questions ?? null,
              answer_schema: null,
              title: null,
              node_id: call.node,
              options: null,
            },
            call.callId,
          )
        } else if (call.tool === "ask_manager") {
          await handlers.askManager?.(args, call.callId)
        }
      } catch (error) {
        // Only the error's name: its message may quote the question or its arguments.
        this.#log(`could not store the question of call ${call.callId}: ${errorName(error)}`)
      }
    }
  }
}

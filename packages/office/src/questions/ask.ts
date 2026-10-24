/** The office side of a run's `ask_user`, and storing questions until they are answered. */
import { type DiscussionEntry, Question, now, validationMessage } from "@opencorp/protocol"
import { newId, type QuestionRecord, type SessionRecord, type WorkItemRecord } from "../store/store.ts"
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

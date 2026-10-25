/** Company tools every person has, bound to the caller: ask_manager, create_work_item, comment. */
import { Comment, Question, WorkItem, now, validationMessage } from "@opencorp/protocol"
import type { z } from "zod"
import type { CompanyRepo } from "../../company/loader.ts"
import { repr } from "../../perm/redact.ts"
import type { Carried, OnQuestion } from "../../questions/ask.ts"
import { formatAnswer } from "../../questions/format.ts"
import { normalizeOptions } from "../../questions/normalize.ts"
import { newId, type SessionRecord, type Store } from "../../store/store.ts"
import type { ToolContext } from "../context.ts"

/** Code points of the question an `ask_manager` work item keeps as its title. */
export const TITLE_CHARS = 80

/** A model-facing company tool: its description and JSON Schema, and a call that returns text. */
export interface CompanyTool {
  readonly description: string
  readonly parameters: Record<string, unknown>
  call(args: Record<string, unknown>): string | Promise<string>
}

const ASK =
  "Ask your manager a question and wait for the answer.\n\n" +
  "Use it for a decision or information your manager must give. Put the context\n" +
  "they need in one or two sentences."
const CREATE =
  "Create a work item (a task) under the one you are working on.\n\n" +
  "`assignee` is a person's handle, without the @; leave it out to leave the task unassigned."
const COMMENT = "Add a comment to a work item."

/** Python's whitespace for `str.split()`. */
const SPACES = /[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/

/**
 * The `company` tool group for `session.person`'s run `runId`.
 *
 * `repo` is the run's pinned company repo (for the caller's manager and valid assignees). `ask_manager` hands
 * `onQuestion` its question and a work item for the manager, waits until the manager answers, then closes the item.
 * A tool's error reaches the model as `error: <message>`.
 */
export function companyTools(
  store: Store,
  repo: CompanyRepo,
  session: SessionRecord,
  runId: string,
  onQuestion: OnQuestion,
  { carried }: { carried?: Carried } = {},
): Record<string, CompanyTool> {
  const caller = repo.people.get(session.person)
  const names = caller ? [caller.handle, caller.name] : [session.person]

  return {
    ask_manager: {
      description: ASK,
      parameters: {
        description: ASK,
        properties: {
          question: { title: "Question", type: "string" },
          options: {
            default: null,
            description: "Optional 2-4 short answer choices. Your manager can always type a different answer.",
            title: "Options",
          },
        },
        required: ["question"],
        title: "ask_manager",
        type: "object",
      },
      call: async (args) => {
        const manager = caller?.manager
        if (manager == null) throw new RangeError("you have no manager to ask")
        const question = args.question
        if (typeof question !== "string") throw new TypeError("question must be a string")
        const title = [...question.split(SPACES).filter(Boolean).join(" ")].slice(0, TITLE_CHARS).join("") || "Question"
        const item = record(WorkItem, {
          ...stamped(),
          title,
          kind: "question",
          requester: session.person,
          assignee: manager,
          parent_id: session.work_item_id,
        })
        const t = now()
        const answered = await onQuestion(
          record(Question, {
            id: newId(),
            session_id: session.id,
            run_id: runId,
            node_id: null,
            source: "ask_manager",
            asker: session.person,
            work_item_id: item.id,
            question,
            options: normalizeOptions(args.options, { names }),
            status: "open",
            created_at: t,
            updated_at: t,
          }),
          { workItem: item },
        )
        store.updateWorkItem(item.id, { status: "done", resolved_by: answered.answered_by })
        // An ask_manager question is never an `ask` node's, so its formatted answer is text.
        return formatAnswer(answered, carried ? carried(answered) : []) as string
      },
    },
    create_work_item: {
      description: CREATE,
      parameters: {
        description: CREATE,
        properties: {
          title: { title: "Title", type: "string" },
          summary: { anyOf: [{ type: "string" }, { type: "null" }], default: null, title: "Summary" },
          assignee: { anyOf: [{ type: "string" }, { type: "null" }], default: null, title: "Assignee" },
        },
        required: ["title"],
        title: "create_work_item",
        type: "object",
      },
      call: (args) => {
        const assignee = args.assignee ?? null
        if (assignee !== null && (typeof assignee !== "string" || !repo.people.has(assignee))) {
          throw new RangeError(`no person ${repr(String(assignee))}`)
        }
        const item = store.createWorkItem(
          record(WorkItem, {
            ...stamped(),
            title: args.title,
            kind: "task",
            requester: session.person,
            assignee,
            parent_id: session.work_item_id,
            summary: args.summary ?? null,
          }),
        )
        return `created work item ${item.id}`
      },
    },
    comment: {
      description: COMMENT,
      parameters: {
        description: COMMENT,
        properties: {
          work_item_id: { title: "Work Item Id", type: "string" },
          body: { title: "Body", type: "string" },
        },
        required: ["work_item_id", "body"],
        title: "comment",
        type: "object",
      },
      call: (args) => {
        const id = args.work_item_id
        // Only a string reaches the store: SQLite binds an object as named parameters and an array as positional ones.
        if (typeof id !== "string" || store.getWorkItem(id) === undefined) {
          throw new RangeError(`no work item ${repr(String(id))}`)
        }
        const comment = { id: newId(), work_item_id: id, author: session.person, body: args.body, created_at: now() }
        store.addComment(record(Comment, comment))
        return `commented on ${id}`
      },
    },
  }
}

/** A new open record's id and times. */
function stamped(): Record<string, unknown> {
  const t = now()
  return { id: newId(), status: "open", created_at: t, updated_at: t }
}

/** `data` parsed by `schema`; a failure is a `TypeError` naming only the bad fields. */
function record<S extends z.ZodType>(schema: S, data: Record<string, unknown>): z.output<S> {
  const parsed = schema.safeParse(data)
  // Only validationMessage's text leaves: the ZodError and its issues can quote the args' values.
  if (!parsed.success) throw new TypeError(validationMessage(schema, parsed.error, data))
  return parsed.data
}

/** Rejects as `BaseHandlers.askUser` does: a run with no one to ask. */
const noAnswer: OnQuestion = async () => {
  throw new Error("nobody is here to answer")
}

/** `companyTools` for `ctx`'s run; none without its store, repo, session and run id. */
export function tools(ctx: ToolContext): Record<string, CompanyTool> {
  if (ctx.store === undefined || ctx.repo === undefined || ctx.session === undefined || ctx.runId == null) return {}
  return companyTools(ctx.store, ctx.repo, ctx.session, ctx.runId, ctx.onQuestion ?? noAnswer, {
    carried: ctx.carried,
  })
}

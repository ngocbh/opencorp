/** Work item tools: read-only lookups of the work items a person can see. */
import { pyJson } from "../perm/redact.ts"
import type { QuestionRecord, Store, WorkItemRecord } from "../store/store.ts"
import type { ToolContext } from "./context.ts"

/** A model-facing work item tool: its description and JSON Schema, and a call that returns JSON text. */
export interface WorkItemTool {
  readonly description: string
  readonly parameters: Record<string, unknown>
  call(args: Record<string, unknown>): string
}

const LIST = "List the work items you can see (yours, and those around this question), newest first, as JSON."
const READ = "Read one work item with its comments and children, as JSON."

/**
 * Read-only work item tools for a side chat of `handle` about `question`.
 *
 * The person sees the question's work item and the work item of the session that asked, their parents, and their
 * children, plus items they requested or are assigned. Anything else is "no work item", for hidden and unknown ids
 * alike.
 */
export function workItemTools(
  store: Store,
  handle: string,
  question: QuestionRecord | null | undefined,
): Record<string, WorkItemTool> {
  const roots: string[] = question?.work_item_id ? [question.work_item_id] : []
  const asker = question ? store.getSession(question.session_id) : undefined
  if (asker?.work_item_id) roots.push(asker.work_item_id)
  const chain = new Set<string>()
  for (const root of roots) {
    let itemId: string | null | undefined = root
    let item: WorkItemRecord | undefined
    while (itemId && !chain.has(itemId) && (item = store.getWorkItem(itemId)) !== undefined) {
      chain.add(item.id)
      itemId = item.parent_id
    }
  }

  const visible = (item: WorkItemRecord): boolean =>
    chain.has(item.id) ||
    (item.parent_id != null && chain.has(item.parent_id)) ||
    handle === item.requester ||
    handle === item.assignee

  return {
    list_work_items: {
      description: LIST,
      parameters: { description: LIST, properties: {}, title: "list_work_items", type: "object" },
      call: () =>
        pyJson(
          store
            .listWorkItems()
            .filter(visible)
            .map((i) => ({ id: i.id, title: i.title, status: i.status, assignee: i.assignee, parent_id: i.parent_id })),
        ),
    },
    read_work_item: {
      description: READ,
      parameters: {
        description: READ,
        properties: { work_item_id: { title: "Work Item Id", type: "string" } },
        required: ["work_item_id"],
        title: "read_work_item",
        type: "object",
      },
      call: (args) => {
        const id = args.work_item_id as string
        const item = store.getWorkItem(id)
        if (item === undefined || !visible(item)) throw new RangeError(`no work item ${id}`)
        const { version: _, ...rest } = item
        const children = store
          .listWorkItems()
          .filter((c) => c.parent_id === item.id)
          .map((c) => ({ id: c.id, title: c.title, status: c.status }))
        const comments = store
          .listComments(item.id)
          .map((c) => ({ author: c.author, body: c.body, created_at: c.created_at }))
        return pyJson({ ...rest, comments, children })
      },
    },
  }
}

/** The `work_items` group: `workItemTools` for `ctx.session`'s person about `ctx.question`; none without a store
 *  and session. */
export function tools(ctx: ToolContext): Record<string, WorkItemTool> {
  if (ctx.store === undefined || ctx.session === undefined) return {}
  return workItemTools(ctx.store, ctx.session.person, ctx.question)
}

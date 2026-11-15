/** Work-item routes. */
import { Comment, WorkItem } from "@opencorp/protocol"
import { z } from "zod"
import { HttpError, type Params, type Route } from "../http.ts"
import type { RequestContext } from "../office.ts"

/** The work item `id`; 404 if there is none. */
function item(ctx: RequestContext, id: string) {
  const found = ctx.office.store.getWorkItem(id)
  if (found === undefined) throw new HttpError(404, "not_found", `no work item ${id}`)
  return found
}

/** One work item. */
export function getWorkItem(ctx: RequestContext, params: Params) {
  return item(ctx, params.id!)
}

/** A work item's comments, oldest first. */
export function listComments(ctx: RequestContext, params: Params) {
  return ctx.office.store.listComments(item(ctx, params.id!).id)
}

/** The work-item routes. */
export const ROUTES: readonly Route<RequestContext>[] = [
  { method: "GET", path: "/work-items/:id", reply: WorkItem, handler: getWorkItem },
  { method: "GET", path: "/work-items/:id/comments", reply: z.array(Comment), handler: listComments },
]

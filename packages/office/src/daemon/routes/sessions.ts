/** Session routes: listing, reading, the current turn, and session actions. */
import { type ErrorCode, Message, Session } from "@opencorp/protocol"
import { z } from "zod"
import { HarnessError } from "../../chat/state.ts"
import { strip } from "../../perm/redact.ts"
import type { SessionRecord } from "../../store/store.ts"
import { HttpError, type Params, type Route } from "../http.ts"
import type { RequestContext, SessionHarness } from "../office.ts"

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

/** `raw` as a page size: digits only, from 1 to MAX_LIMIT; DEFAULT_LIMIT when absent. */
function limit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT
  const n = /^[0-9]+$/.test(raw) ? Number(raw) : 0
  if (n < 1 || n > MAX_LIMIT)
    throw new HttpError(422, "invalid_body", `limit must be an integer from 1 to ${MAX_LIMIT}`)
  return n
}

/** Sessions, most recently updated first, optionally for one person, kind and folder, and in the given statuses.
 *
 *  `status` may repeat or be comma-separated (`?status=busy,idle`), as on `/questions`. `cwd` is a folder's resolved
 *  path, as sessions store it. A repeated `person`, `kind`, `cwd` or `limit` counts its last value, as Starlette's
 *  `get` reads it. */
export function listSessions(ctx: RequestContext) {
  const q = ctx.query
  const statuses = q
    .getAll("status")
    .flatMap((raw) => raw.split(","))
    .map(strip)
    .filter((s) => s !== "")
  // An empty value is passed on as Python's was (`?person=` matches no session), unlike `/questions`' empty
  // `session`.
  const last = (name: string) => q.getAll(name).at(-1)
  return ctx.office.store.listSessions({
    person: last("person"),
    status: statuses.length > 0 ? statuses : undefined,
    kind: last("kind"),
    cwd: last("cwd"),
    limit: limit(last("limit")),
  })
}

/** The stored session `id`, or 404. */
function stored(ctx: RequestContext, id: string): SessionRecord {
  const found = ctx.office.store.getSession(id)
  if (found === undefined) throw new HttpError(404, "not_found", `no session ${id}`)
  return found
}

/** One session. */
export function getSession(ctx: RequestContext, params: Params) {
  return stored(ctx, params.id!)
}

/** The office's session harness; 501 if this office runs none. The message names the route pattern because a
 *  handler can't see its request path. */
export function harness(ctx: RequestContext, route: string): SessionHarness {
  const found = ctx.office.harness
  if (found === undefined) throw new HttpError(501, "not_implemented", `${route} is not implemented yet`)
  return found
}

/** Runs a harness call; a `HarnessError` becomes an `HttpError` with its status, code and message. */
export async function harnessCall<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof HarnessError) throw new HttpError(error.status, error.code as ErrorCode, error.message)
    throw error
  }
}

/** What a client reads of a session before following its live events: a Codex session's current turn. 404 comes
 *  first: Python's transcript read was a store read, with no harness. */
export async function listMessages(ctx: RequestContext, params: Params) {
  const session = stored(ctx, params.id!)
  const actor = harness(ctx, "GET /sessions/:id/messages")
  return harnessCall(() => actor.messages(session.id))
}

/** The session routes. */
export const ROUTES: readonly Route<RequestContext>[] = [
  { method: "GET", path: "/sessions", reply: z.array(Session), handler: listSessions },
  { method: "GET", path: "/sessions/:id", reply: Session, handler: getSession },
  { method: "GET", path: "/sessions/:id/messages", reply: z.array(Message), handler: listMessages },
]

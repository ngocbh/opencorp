/** Session routes: listing, reading, the current turn, and session actions. */
import {
  Ack,
  CostCapRequest,
  CreateSessionRequest,
  type ErrorCode,
  Message,
  MessagePage,
  PromptRequest,
  Session,
  SetModeRequest,
  SetModelRequest,
  Ulid,
} from "@opencorp/protocol"
import { z } from "zod"
import { HarnessError } from "../../runtime/sessions/state.ts"
import { strip } from "../../util/redact.ts"
import type { SessionHarness } from "../../runtime/sessions/harness.ts"
import type { SessionRecord } from "../../runtime/store/store.ts"
import { actingPerson } from "../auth.ts"
import { HttpError, type Params, type Route } from "../http.ts"
import type { RequestContext } from "../office.ts"

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

/** What a client reads of a session before following its live events: a yian chat's transcript or a Codex
 *  session's current turn, whole or a page of it (`messagesReply`). 404 comes first: Python's transcript read was a
 *  store read, with no harness. */
export async function listMessages(ctx: RequestContext, params: Params) {
  const session = stored(ctx, params.id!)
  const actor = harness(ctx, "GET /sessions/:id/messages")
  return messagesReply(ctx.query, session.id, () => harnessCall(() => actor.messages(session.id)))
}

/** The longest cursor a page gives: a message id is far shorter. */
const MAX_CURSOR = 1024

/** What a page's cursor holds: the session and the id of the message the next, older page ends before. */
const Cursor = z.strictObject({ session: Ulid, id: Message.shape.id })

/** A page's cursor: `Cursor` as base64url JSON. */
function cursor(sessionId: string, messageId: string): string {
  return Buffer.from(JSON.stringify({ session: sessionId, id: messageId })).toString("base64url")
}

/** The message id `raw`, a page's cursor, names in session `sessionId`; 400 `bad_cursor` for anything a page of this
 *  session didn't give. Its text echoes nothing of the request. */
function cursorId(raw: string, sessionId: string): string {
  const bad = () => new HttpError(400, "bad_cursor", "before isn't a cursor a page of this session's messages gave")
  if (raw.length > MAX_CURSOR || !/^[A-Za-z0-9_-]+$/.test(raw)) throw bad()
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
  } catch {
    throw bad()
  }
  const parsed = Cursor.safeParse(value)
  if (!parsed.success) throw bad()
  if (parsed.data.session !== sessionId) {
    throw new HttpError(400, "bad_cursor", "before is a cursor of another session's messages")
  }
  return parsed.data.id
}

/**
 * Session `sessionId`'s messages as `query` asks for them, from `read`. With neither `limit` nor `before`, all of
 * them. Otherwise a page, as upstream's message list pages: the newest `limit` (from 1 to MAX_LIMIT, DEFAULT_LIMIT
 * when absent; 422 otherwise) before the message `before` names, or the newest of all, oldest first, with `next`, the
 * cursor of the page before it, null at the first message. A cursor names a message, so newer ones arriving don't
 * move it; one this session's pages didn't give, or whose message the transcript no longer has, is 400 `bad_cursor`.
 * The no-office host serves its session's messages through it too.
 */
export async function messagesReply(
  query: URLSearchParams,
  sessionId: string,
  read: () => Promise<Message[]>,
): Promise<Message[] | MessagePage> {
  const last = (name: string) => query.getAll(name).at(-1)
  const [rawLimit, rawBefore] = [last("limit"), last("before")]
  if (rawLimit === undefined && rawBefore === undefined) return read()
  const n = limit(rawLimit)
  const before = rawBefore === undefined ? null : cursorId(rawBefore, sessionId)
  const messages = await read()
  const end = before === null ? messages.length : messages.findIndex((m) => m.id === before)
  if (end < 0) {
    throw new HttpError(400, "bad_cursor", "before names a message this session's transcript no longer has")
  }
  const start = Math.max(0, end - n)
  return { messages: messages.slice(start, end), next: start > 0 ? cursor(sessionId, messages[start]!.id) : null }
}

/** Start a person's main chat in a folder, opened by the request's person, on the model the office chooses. */
export function createSession(ctx: RequestContext, _params: Params, body: unknown) {
  const { person, cwd, harness: kind, connection, model } = body as z.output<typeof CreateSessionRequest>
  const actor = harness(ctx, "POST /sessions")
  const openedBy = actingPerson(ctx)
  return harnessCall(() => actor.startSession(person, cwd, { harness: kind, openedBy, connection, model }))
}

/** Send a message: the next turn, an answer to the model's question, a steer, or queued. */
export async function prompt(ctx: RequestContext, params: Params, body: unknown) {
  const { text } = body as z.output<typeof PromptRequest>
  const actor = harness(ctx, "POST /sessions/:id/prompt")
  const by = actingPerson(ctx)
  await harnessCall(() => actor.prompt(params.id!, text, { by }))
  return { ok: true }
}

/** Steer the running reply (a prompt when none is running). */
export async function steer(ctx: RequestContext, params: Params, body: unknown) {
  const { text } = body as z.output<typeof PromptRequest>
  const actor = harness(ctx, "POST /sessions/:id/steer")
  const by = actingPerson(ctx)
  await harnessCall(() => actor.steer(params.id!, text, { by }))
  return { ok: true }
}

/** Esc: stop the running reply and its calls; the session stays open. */
export async function interrupt(ctx: RequestContext, params: Params) {
  const actor = harness(ctx, "POST /sessions/:id/interrupt")
  await harnessCall(() => actor.interrupt(params.id!))
  return { ok: true }
}

/** End the session (interrupting a busy reply first); a session already ending is left as it is. */
export async function end(ctx: RequestContext, params: Params) {
  const actor = harness(ctx, "POST /sessions/:id/end")
  await harnessCall(() => actor.end(params.id!))
  return { ok: true }
}

/** Continue an ended Codex session on its thread, as a new session opened by the request's person. */
export function continueSession(ctx: RequestContext, params: Params) {
  const actor = harness(ctx, "POST /sessions/:id/continue")
  const by = actingPerson(ctx)
  return harnessCall(() => actor.continueSession(params.id!, { by }))
}

/** Set the session's cost cap; it must be above the cost so far. Held turns go on. */
export function costCap(ctx: RequestContext, params: Params, body: unknown) {
  const { cost_cap_usd } = body as z.output<typeof CostCapRequest>
  const actor = harness(ctx, "POST /sessions/:id/cost-cap")
  return harnessCall(() => actor.setCostCap(params.id!, cost_cap_usd))
}

/** Switch the session's connection and model; its next turn runs on them. Anyone who may chat may switch. */
export function setModel(ctx: RequestContext, params: Params, body: unknown) {
  const { connection, model } = body as z.output<typeof SetModelRequest>
  const actor = harness(ctx, "POST /sessions/:id/model")
  return harnessCall(() => actor.setModel(params.id!, connection, model))
}

/** Switch the session's mode; only its approver may. */
export function setMode(ctx: RequestContext, params: Params, body: unknown) {
  const { mode } = body as z.output<typeof SetModeRequest>
  const actor = harness(ctx, "POST /sessions/:id/mode")
  return harnessCall(() => actor.setMode(params.id!, mode, { by: actingPerson(ctx) }))
}

/** The session routes. */
export const ROUTES: readonly Route<RequestContext>[] = [
  { method: "GET", path: "/sessions", reply: z.array(Session), handler: listSessions },
  { method: "POST", path: "/sessions", body: CreateSessionRequest, reply: Session, handler: createSession },
  { method: "GET", path: "/sessions/:id", reply: Session, handler: getSession },
  {
    method: "GET",
    path: "/sessions/:id/messages",
    reply: z.union([z.array(Message), MessagePage]),
    handler: listMessages,
  },
  { method: "POST", path: "/sessions/:id/prompt", body: PromptRequest, reply: Ack, handler: prompt },
  { method: "POST", path: "/sessions/:id/steer", body: PromptRequest, reply: Ack, handler: steer },
  { method: "POST", path: "/sessions/:id/interrupt", reply: Ack, handler: interrupt },
  { method: "POST", path: "/sessions/:id/end", reply: Ack, handler: end },
  { method: "POST", path: "/sessions/:id/continue", reply: Session, handler: continueSession },
  { method: "POST", path: "/sessions/:id/cost-cap", body: CostCapRequest, reply: Session, handler: costCap },
  { method: "POST", path: "/sessions/:id/model", body: SetModelRequest, reply: Session, handler: setModel },
  { method: "POST", path: "/sessions/:id/mode", body: SetModeRequest, reply: Session, handler: setMode },
]

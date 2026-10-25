/** Question routes: listing, reading, and answering questions, and question-card actions. */
import { AnswerRequest, Question, SendBackRequest, Session, SideChatRequest } from "@opencorp/protocol"
import { z } from "zod"
import { strip } from "../../perm/redact.ts"
import type { Cards } from "../../questions/cards.ts"
import { InvalidTransition } from "../../store/store.ts"
import { actingPerson } from "../auth.ts"
import { HttpError, type Params, type Route } from "../http.ts"
import type { RequestContext } from "../office.ts"
import { harnessCall } from "./sessions.ts"

/** The office's question cards; 501 if this office runs no session actor. The message names the route pattern
 *  because a handler can't see its request path. */
function cards(ctx: RequestContext, path: string): Cards {
  const found = ctx.office.cards
  if (found === undefined) throw new HttpError(501, "not_implemented", `POST ${path} is not implemented yet`)
  return found
}

/**
 * Questions, oldest first, optionally for one session and in the given statuses.
 *
 * `status` may repeat or be comma-separated (`?status=open, answered`); an empty `session` counts as absent. The
 * event stream has no replay, so a client that (re)connects finds open questions here.
 */
export function listQuestions(ctx: RequestContext) {
  const statuses = ctx.query
    .getAll("status")
    .flatMap((raw) => raw.split(","))
    .map(strip)
    .filter((s) => s !== "")
  // The last one, as Starlette's `get` reads a repeated param.
  const session = ctx.query.getAll("session").at(-1)
  // An empty status list would match nothing.
  return ctx.office.store.listQuestions({
    sessionId: session || undefined,
    status: statuses.length > 0 ? statuses : undefined,
  })
}

/** One question. */
export function getQuestion(ctx: RequestContext, params: Params) {
  const found = ctx.office.store.getQuestion(params.id!)
  if (found === undefined) throw new HttpError(404, "not_found", `no question ${params.id}`)
  return found
}

/** Answer an open question as the request's person; the first answer wins, a second gets 409 `not_open`. It goes
 *  through the cards when the office has them, else through the session actor, else straight to the store. */
export async function answerQuestion(ctx: RequestContext, params: Params, body: unknown) {
  const { answer, answer_kind: kind } = body as z.output<typeof AnswerRequest>
  const { office } = ctx
  const by = actingPerson(ctx)
  const id = params.id!
  // The cards check the answer against its card and keep the side chat's discussion.
  const found = office.cards
  if (found !== undefined) return harnessCall(() => found.answer(id, answer, kind, { by }))
  const harness = office.harness
  if (harness !== undefined) return harnessCall(() => harness.answer(id, answer, kind, { by }))
  try {
    return office.store.answerQuestion(id, answer, kind, by)
  } catch (error) {
    if (error instanceof InvalidTransition) throw new HttpError(409, "not_open", error.message)
    throw error
  }
}

/** "Chat about this": send the first (or next) message to the question's side session; return the session. */
export function sideChat(ctx: RequestContext, params: Params, body: unknown) {
  const { text } = body as z.output<typeof SideChatRequest>
  const found = cards(ctx, "/questions/:id/side")
  return harnessCall(() => found.openSide(params.id!, text, { by: actingPerson(ctx) }))
}

/** Answer the question with its discussion and no decision; `note` is the human's last word in it. */
export function sendBack(ctx: RequestContext, params: Params, body: unknown) {
  const { note } = body as z.output<typeof SendBackRequest>
  const found = cards(ctx, "/questions/:id/send-back")
  return harnessCall(() => found.sendBack(params.id!, note, { by: actingPerson(ctx) }))
}

/** Stop the asker from its card: it gets `[interrupted by the user]` with the discussion. */
export function stop(ctx: RequestContext, params: Params) {
  const found = cards(ctx, "/questions/:id/stop")
  return harnessCall(() => found.stop(params.id!, { by: actingPerson(ctx) }))
}

/** Stop carrying an expired question's discussion into this one. */
export function dismissCarried(ctx: RequestContext, params: Params) {
  const found = cards(ctx, "/questions/:id/carried/dismiss")
  return harnessCall(() => found.dismissCarried(params.id!))
}

/** The question routes. */
export const ROUTES: readonly Route<RequestContext>[] = [
  { method: "GET", path: "/questions", reply: z.array(Question), handler: listQuestions },
  { method: "GET", path: "/questions/:id", reply: Question, handler: getQuestion },
  { method: "POST", path: "/questions/:id/answer", body: AnswerRequest, reply: Question, handler: answerQuestion },
  { method: "POST", path: "/questions/:id/side", body: SideChatRequest, reply: Session, handler: sideChat },
  { method: "POST", path: "/questions/:id/send-back", body: SendBackRequest, reply: Question, handler: sendBack },
  { method: "POST", path: "/questions/:id/stop", reply: Question, handler: stop },
  { method: "POST", path: "/questions/:id/carried/dismiss", reply: Question, handler: dismissCarried },
]

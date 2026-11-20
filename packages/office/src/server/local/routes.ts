/** The no-office host's routes: the office's session, question, rules, event and instrument routes, over the host's
 *  one session, with the same paths, bodies, replies and errors. Any other route is the pipeline's 404 `no_route`,
 *  which a client takes as "not served". Every request acts as the owner, who alone answers cards, sends keys,
 *  switches the mode and removes rules. */
import {
  Ack,
  AnswerRequest,
  Message,
  Person,
  PromptRequest,
  Question,
  RemoveRuleRequest,
  RuleList,
  Session,
  SetModeRequest,
} from "@opencorp/protocol"
import { z } from "zod"
import type { SessionRecord } from "../../runtime/store/store.ts"
import { strip } from "../../util/redact.ts"
import { HttpError, type Params, type Route } from "../http.ts"
import { eventRoutesOf } from "../routes/events.ts"
import { instrumentRoutes } from "../routes/instruments.ts"
import { harnessCall } from "../routes/sessions.ts"
import type { LocalHost } from "./host.ts"

/** What a route sees: the host, who the request acts as (the owner, for the host's token), and the request's abort
 *  signal and query. */
export interface LocalContext {
  readonly host: LocalHost
  readonly person: string
  readonly signal: AbortSignal
  readonly query: URLSearchParams
}

/** The last value of query parameter `name`, as the office reads a repeated one. */
const last = (ctx: LocalContext, name: string) => ctx.query.getAll(name).at(-1)

/** Query parameter `name`'s values, repeated or comma-separated, blanks dropped; undefined for none. */
function listed(ctx: LocalContext, name: string): string[] | undefined {
  const values = ctx.query
    .getAll(name)
    .flatMap((raw) => raw.split(","))
    .map(strip)
    .filter((s) => s !== "")
  return values.length > 0 ? values : undefined
}

/** The session `:id`, or 404. */
function stored(ctx: LocalContext, params: Params): SessionRecord {
  const found = ctx.host.session(params.id!)
  if (found === undefined) throw new HttpError(404, "not_found", `no session ${params.id}`)
  return found
}

/** 403 `forbidden` unless the request acts as the session's approver, its owner. */
function onlyOwner(what: string): NonNullable<Route<LocalContext>["guard"]> {
  return (ctx, params) => {
    const approver = ctx.host.approver(stored(ctx, params))
    if (ctx.person !== approver) throw new HttpError(403, "forbidden", `only @${approver} may ${what}`)
  }
}

/** The most sessions a page holds, as on the office. */
const MAX_LIMIT = 500

/** The session, if it matches the office's filters (`person`, `kind`, `cwd`, `status`); a `limit` is checked as the
 *  office checks it. */
function listSessions(ctx: LocalContext): SessionRecord[] {
  const raw = last(ctx, "limit")
  const n = raw === undefined ? 1 : /^[0-9]+$/.test(raw) ? Number(raw) : 0
  if (n < 1 || n > MAX_LIMIT) {
    throw new HttpError(422, "invalid_body", `limit must be an integer from 1 to ${MAX_LIMIT}`)
  }
  const session = ctx.host.session()!
  const statuses = listed(ctx, "status")
  const fields: [string, string][] = [["person", session.person], ["kind", session.kind], ["cwd", session.cwd]]
  const fits = fields.every(([name, value]) => [undefined, value].includes(last(ctx, name)))
  return fits && (statuses === undefined || statuses.includes(session.status)) ? [session] : []
}

/** The host's routes. `pingMs` sets the event stream's idle ping. */
export function localRoutes({ pingMs }: { pingMs?: number } = {}): Route<LocalContext>[] {
  return [
    ...eventRoutesOf<LocalContext>((ctx) => ctx.host, pingMs),
    { method: "GET", path: "/whoami", handler: (ctx) => ({ person: ctx.person, device: null }) },
    { method: "GET", path: "/people", reply: z.array(Person), handler: (ctx) => ctx.host.people() },
    { method: "GET", path: "/folders/*cwd/people", reply: z.array(Person), handler: (ctx) => ctx.host.people() },
    { method: "GET", path: "/sessions", reply: z.array(Session), handler: listSessions },
    { method: "GET", path: "/sessions/:id", reply: Session, handler: stored },
    {
      method: "GET",
      path: "/sessions/:id/messages",
      reply: z.array(Message),
      handler: (ctx, params) => {
        stored(ctx, params)
        return ctx.host.messages()
      },
    },
    ...(["prompt", "steer"] as const).map(
      (action): Route<LocalContext> => ({
        method: "POST",
        path: `/sessions/:id/${action}`,
        body: PromptRequest,
        reply: Ack,
        handler: async (ctx, params, body) => {
          stored(ctx, params)
          const { text } = body as z.output<typeof PromptRequest>
          await harnessCall(() => ctx.host[action](text, ctx.person))
          return { ok: true }
        },
      }),
    ),
    ...(["interrupt", "end"] as const).map(
      (action): Route<LocalContext> => ({
        method: "POST",
        path: `/sessions/:id/${action}`,
        reply: Ack,
        handler: async (ctx, params) => {
          stored(ctx, params)
          await harnessCall(() => ctx.host[action]())
          return { ok: true }
        },
      }),
    ),
    {
      method: "POST",
      path: "/sessions/:id/mode",
      guard: onlyOwner("switch this session's mode"),
      body: SetModeRequest,
      reply: Session,
      handler: (ctx, _params, body) => {
        const { mode } = body as z.output<typeof SetModeRequest>
        return harnessCall(() => ctx.host.setMode(mode, ctx.person))
      },
    },
    {
      method: "GET",
      path: "/sessions/:id/rules",
      reply: RuleList,
      handler: (ctx, params) => {
        stored(ctx, params)
        return ctx.host.rules()
      },
    },
    {
      method: "POST",
      path: "/sessions/:id/rules/remove",
      guard: onlyOwner("remove this session's rules"),
      body: RemoveRuleRequest,
      reply: Ack,
      handler: async (ctx, _params, body) => {
        await harnessCall(() => ctx.host.removeRule(body as z.output<typeof RemoveRuleRequest>, ctx.person))
        return { ok: true }
      },
    },
    ...instrumentRoutes<LocalContext>((ctx) => ctx.host),
    {
      method: "GET",
      path: "/questions",
      reply: z.array(Question),
      handler: (ctx) => ctx.host.questions({ session: last(ctx, "session") || undefined, status: listed(ctx, "status") }),
    },
    {
      method: "GET",
      path: "/questions/:id",
      reply: Question,
      handler: (ctx, params) => {
        const found = ctx.host.question(params.id!)
        if (found === undefined) throw new HttpError(404, "not_found", `no question ${params.id}`)
        return found
      },
    },
    {
      method: "POST",
      path: "/questions/:id/answer",
      guard: (ctx, params) => {
        const found = ctx.host.question(params.id!)
        if (found === undefined) throw new HttpError(404, "not_found", `no question ${params.id}`)
        const approver = ctx.host.approver(ctx.host.session()!)
        if (ctx.person !== approver) throw new HttpError(403, "forbidden", `only @${approver} may answer this card`)
      },
      body: AnswerRequest,
      reply: Question,
      handler: (ctx, params, body) => {
        const { answer, answer_kind: kind } = body as z.output<typeof AnswerRequest>
        return harnessCall(() => ctx.host.answer(params.id!, answer, kind, ctx.person))
      },
    },
    {
      // A card's stop is Esc on its chat, as in the office.
      method: "POST",
      path: "/questions/:id/stop",
      reply: Question,
      handler: (ctx, params) => harnessCall(() => ctx.host.stopQuestion(params.id!, ctx.person)),
    },
  ]
}

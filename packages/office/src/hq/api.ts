/** The HQ app each HQ listener serves: the /api allowlist and the built web app. */
import type { IncomingMessage, ServerResponse } from "node:http"
import {
  BrowserSession,
  type BrowserSession as BrowserSessionType,
  CompanyFile,
  CompanyTree,
  CompanyView,
  CostReport,
  type ErrorCode,
  Health,
  PairRequest,
  Person,
  WorkItem,
} from "@opencorp/protocol"
import type { z } from "zod"
import { blankSecrets } from "../company/secret_keys.ts"
import { SourceError } from "../company/source.ts"
import { HttpError, RawReply, type RequestInfo, type Route, requestListener } from "../daemon/http.ts"
import type { RequestContext } from "../daemon/office.ts"
import { costs } from "../daemon/routes/costs.ts"
import { whoami } from "../daemon/routes/devices.ts"
import { getWorkItem } from "../daemon/routes/work_items.ts"
import { browserAuth, cookieName, cookieValue } from "./auth.ts"
import type { Hq } from "./core.ts"
import { hqGuard, isApi, requestPath } from "./guard.ts"
import { serveApp } from "./static.ts"

/** What an HQ route sees: the socket's context plus HQ, the raw request, and the browser session. */
export interface HqContext extends RequestContext {
  hq: Hq
  req: IncomingMessage
  /** The browser session's id; null on the open requests. */
  session: string | null
  /** The company at HEAD the session was checked against; null on the open requests. */
  company: z.output<typeof CompanyView> | null
}

/** The cookie's lifetime in seconds: the session's. */
export const MAX_AGE = 30 * 24 * 3600

/** The Set-Cookie header for HQ's session. */
function setCookie(req: IncomingMessage, value: string, maxAge = MAX_AGE): string {
  // No `Secure`: HQ serves no TLS.
  return `${cookieName(req)}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`
}

/** `session` as the reply, with the cookie carrying `value`. */
function sessionReply(req: IncomingMessage, session: BrowserSessionType, value: string): RawReply {
  return new RawReply(200, { "set-cookie": setCookie(req, value) }, JSON.stringify(BrowserSession.parse(session)))
}

/** The last `name` in the query, as Starlette's `query_params.get`; undefined when absent. */
function last(ctx: HqContext, name: string): string | undefined {
  return ctx.query.getAll(name).at(-1)
}

/** Everything under /api that isn't on the allowlist: the pipeline's own 404, for any method. */
function noRoute(ctx: HqContext): never {
  const raw = ctx.req.url ?? "/"
  const q = raw.indexOf("?")
  throw new HttpError(404, "no_route", `no route ${ctx.req.method} ${q < 0 ? raw : raw.slice(0, q)}`)
}

/** The /api allowlist. It never holds the socket's routes, and the socket's table never holds these, so routing
 *  fails closed; writes (connections, devices, passwords, hire, prompts) stay socket-only. */
export const ROUTES: readonly Route<HqContext>[] = [
  // The office's compatibility key and the built app's. Open without a session.
  { method: "GET", path: "/api/health", reply: Health, handler: (ctx) => ctx.hq.health() },
  { method: "GET", path: "/api/whoami", handler: whoami },
  // The company at HEAD: the snapshot this request's session was checked against, so people, groups and the CEO
  // come from one commit. People come without devices or password hashes.
  {
    method: "GET",
    path: "/api/company",
    reply: CompanyView,
    handler: (ctx) => ({
      ...ctx.company!,
      // The snapshot strips these already; stripped again here because this reply goes to a browser.
      people: ctx.company!.people.map((p) => blankSecrets(Person, p)),
    }),
  },
  // The company repo's files at the commit this request's session was checked against, which becomes a commit
  // files can be read at. Malformed and non-UTF-8 paths are left out.
  {
    method: "GET",
    path: "/api/company/tree",
    reply: CompanyTree,
    handler: (ctx) => ctx.hq.source.tree(ctx.company!.sha),
  },
  // One file at `at`, one of the last commits the tree route served, as stored: 400 `bad_path`, 404 `no_file`
  // or 409 `stale_commit` otherwise.
  {
    method: "GET",
    path: "/api/company/file",
    reply: CompanyFile,
    handler: async (ctx) => {
      try {
        return await ctx.hq.source.file(last(ctx, "at"), last(ctx, "path"))
      } catch (e) {
        if (e instanceof SourceError) throw new HttpError(e.status, e.code as ErrorCode, e.message)
        throw e
      }
    },
  },
  // The sessions list, the questions and the runs, ported later, go here, in Python's order.
  { method: "GET", path: "/api/work-items/:id", reply: WorkItem, handler: getWorkItem },
  { method: "GET", path: "/api/costs", reply: CostReport, handler: costs },
  // The event stream, ported later, goes here.
  // Spends a one-time code from a pairing link and signs this browser in. Open without a session. A local failure
  // after the code is spent burns it; run `opencorp pair` again.
  {
    method: "POST",
    path: "/api/pair",
    body: PairRequest,
    handler: async ({ hq, req }, _params, body) => {
      const { code, label } = body as z.output<typeof PairRequest>
      // Only a session the cookie really proves is replaced; a forged or stale cookie revokes nothing. Checked
      // before the code is spent, so a failing check doesn't burn it.
      const old = await hq.sessions.check(cookieValue(req))
      const pending = hq.codes.redeem(code)
      if (pending === null)
        throw new HttpError(
          400,
          "pair_code_invalid",
          "This link has expired or was already used. Run `opencorp pair` again.",
        )
      const [session, value] = await hq.sessions.issue(pending.handle, { issuedBy: pending.issuer, label })
      if (old) await hq.sessions.revoke(old.id) // pairing again replaces this browser's session
      return sessionReply(req, session, value)
    },
  },
  // Any method, so a wrong method under /api is 404, never 405, as Starlette's catch-all route was.
  ...(["GET", "POST", "PUT", "DELETE"] as const).flatMap((method) =>
    ["/api", "/api/*rest"].map((path): Route<HqContext> => ({ method, path, handler: noRoute })),
  ),
]

/** The app one HQ listener serves: `port` is the TCP listener's bound port, null for hq.sock. */
export function createHqApp(
  hq: Hq,
  { port }: { port: number | null },
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return hqGuard(
    (req, res, body) => {
      if (!isApi(requestPath(req))) return serveApp(req, res, hq.config.appDir)
      // Built per request so the context closes over `req`, which `RequestInfo` doesn't carry: the session check
      // reads its decoded path and first Cookie header.
      const context = async (info: RequestInfo): Promise<HqContext> => {
        const who = await browserAuth(hq.sessions, req)
        return {
          office: hq.office,
          person: who?.person ?? null,
          device: who?.name ?? null,
          signal: info.signal,
          query: info.query,
          hq,
          req,
          session: who?.id ?? null,
          company: who?.view ?? null,
        }
      }
      return requestListener(ROUTES, { context, log: hq.log })(req, res, body)
    },
    { port, devOrigins: hq.config.devOrigins },
  )
}

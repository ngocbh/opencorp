/** The HQ app each HQ listener serves: the /api allowlist and the built web app. */
import type { IncomingMessage, ServerResponse } from "node:http"
import {
  BrowserSession,
  type BrowserSession as BrowserSessionType,
  type CompanyView,
  Health,
  PairRequest,
} from "@opencorp/protocol"
import type { z } from "zod"
import { HttpError, RawReply, type RequestInfo, type Route, requestListener } from "../daemon/http.ts"
import type { RequestContext } from "../daemon/office.ts"
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

/** The /api allowlist. It never holds the socket's routes, and the socket's table never holds these, so routing
 *  fails closed; writes (connections, devices, passwords, hire, prompts) stay socket-only. */
export const ROUTES: readonly Route<HqContext>[] = [
  // The office's compatibility key and the built app's. Open without a session.
  { method: "GET", path: "/api/health", reply: Health, handler: (ctx) => ctx.hq.health() },
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
]

/** The app one HQ listener serves: `port` is the TCP listener's bound port, null for hq.sock. */
export function createHqApp(
  hq: Hq,
  { port }: { port: number | null },
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return hqGuard(
    (req, res, body) => {
      if (!isApi(requestPath(req))) return serveApp(req, res, hq.config.appDir)
      // Built per request, so the session check reads this request's decoded path and first Cookie header.
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

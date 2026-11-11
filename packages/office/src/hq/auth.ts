/** The browser-session check on HQ's /api, after the guard: never the no-device fallback, never a Bearer token. */
import type { IncomingMessage } from "node:http"
import { HttpError } from "../daemon/http.ts"
import { header, isApi, requestPath } from "./guard.ts"
import type { BrowserSessions, Who } from "./sessions.ts"

/** The /api requests served without a session check, as method and decoded path; every non-/api path (the app
 *  itself) is open too. Logout checks its own cookie, so it ends a session the cookie proves even while its person's
 *  file can't be read. */
export const OPEN: ReadonlySet<string> = new Set([
  "GET /api/health",
  "HEAD /api/health",
  "POST /api/pair",
  "POST /api/login",
  "POST /api/logout",
])

/** The 401 message for an /api request without a live session. */
export const SIGN_IN =
  "Sign in with your handle and password, or run `opencorp hq --sign-in` and open the link it prints."

/** `opencorp_hq_<port>`, the port being the Host header's (the whole value without a colon): cookies ignore ports,
 *  so the name tells HQs on one host apart. */
export function cookieName(req: IncomingMessage): string {
  const host = header(req, "host") ?? ""
  return `opencorp_hq_${host.slice(host.lastIndexOf(":") + 1)}`
}

/** The request's HQ session cookie: the last non-empty pair of its name in the first Cookie header, or undefined.
 *  HQ sets one cookie, at `Path=/`, and browsers send longer paths first, so HQ's cookie comes after any same-named
 *  one a page on another port planted at a deeper path. */
export function cookieValue(req: IncomingMessage): string | undefined {
  const name = cookieName(req)
  let value: string | undefined
  for (const part of (header(req, "cookie") ?? "").split(";")) {
    const pair = part.trim()
    const at = pair.indexOf("=")
    if (at >= 0 && pair.slice(0, at) === name && at + 1 < pair.length) value = pair.slice(at + 1)
  }
  return value
}

/**
 * The browser session behind an /api request: null when the request needs none (a non-/api path or one in `OPEN`),
 * else the session's `Who`. Throws `HttpError` 401 `sign_in_required` without a live session.
 *
 * Never the daemon's no-device fallback, and never a Bearer token: `authorization` isn't read. The HQ pipeline puts
 * the person, the device (`who.name`), the session id and the company view in its request context.
 *
 * Takes the `node:http` request rather than the pipeline's `RequestInfo`, whose path is still percent-encoded and
 * whose headers join repeated Cookie values: the open requests are matched on the decoded path, as uvicorn decoded
 * it, and only the first Cookie header counts (its last pair of the cookie's name, as `cookieValue` says). The HQ
 * pipeline is built per request and closes over `req`.
 */
export async function browserAuth(
  sessions: Pick<BrowserSessions, "check">,
  req: IncomingMessage,
): Promise<Who | null> {
  const path = requestPath(req)
  if (!isApi(path) || OPEN.has(`${req.method} ${path}`)) return null
  const who = await sessions.check(cookieValue(req))
  if (who === null) throw new HttpError(401, "sign_in_required", SIGN_IN)
  return who
}

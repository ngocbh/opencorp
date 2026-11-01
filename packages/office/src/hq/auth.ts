/** The browser-session check on HQ's /api, after the guard: never the no-device fallback, never a Bearer token. */
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import type { IncomingMessage } from "node:http"
import path from "node:path"
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
  "Sign in with your handle and password, or run `opencorp pair` on the office machine and open the link it prints."

/** The file in the office dir holding the cookie key. */
export const COOKIE_KEY_FILE = "hq-cookie-key"

const KEY = /^[0-9a-f]{32}$/

/**
 * The office's cookie key, from `officeDir/hq-cookie-key`; a fresh random one, written there (mode 0600), when the
 * file is missing or doesn't hold one. The key is part of the session cookie's name, so a page or server on another
 * port of this host, which can neither read an HttpOnly cookie's name nor HQ's replies, can't name HQ's cookie:
 * it can't shadow it with a same-named one at a deeper path, a nameless `=name=value` one, or a `Set-Cookie`.
 */
export function cookieKey(officeDir: string): string {
  const file = path.join(officeDir, COOKIE_KEY_FILE)
  try {
    const key = fs.readFileSync(file, "utf8").trim()
    if (KEY.test(key)) return key
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
  }
  const key = randomBytes(16).toString("hex")
  fs.mkdirSync(officeDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, `${key}\n`, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  return key
}

/** `opencorp_hq_<port>_<key>`, the port being the Host header's (the whole value without a colon) and `key` the
 *  office's cookie key (`cookieKey`): cookies ignore ports, so the port tells HQs on one host apart, and the key keeps
 *  the name unguessable from other ports. */
export function cookieName(req: IncomingMessage, key: string): string {
  const host = header(req, "host") ?? ""
  return `opencorp_hq_${host.slice(host.lastIndexOf(":") + 1)}_${key}`
}

/** The request's HQ session cookie: the last non-empty pair named `cookieName(req, key)` in the first Cookie header,
 *  or undefined. HQ sets one cookie, at `Path=/`, and browsers send longer paths first. */
export function cookieValue(req: IncomingMessage, key: string): string | undefined {
  const name = cookieName(req, key)
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
 * it, and only the first Cookie header counts (its last pair of the cookie's name, as `cookieValue` says; `key` is the
 * office's cookie key). The HQ
 * pipeline is built per request and closes over `req`.
 */
export async function browserAuth(
  sessions: Pick<BrowserSessions, "check">,
  req: IncomingMessage,
  key: string,
): Promise<Who | null> {
  const path = requestPath(req)
  if (!isApi(path) || OPEN.has(`${req.method} ${path}`)) return null
  const who = await sessions.check(cookieValue(req, key))
  if (who === null) throw new HttpError(401, "sign_in_required", SIGN_IN)
  return who
}

/** The browser-session check on HQ's /api, after the guard: never the no-device fallback, never a Bearer token. */
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import type { IncomingMessage } from "node:http"
import path from "node:path"
import { HttpError, logLine } from "../daemon/http.ts"
import { OfficeStartError, messageOf } from "../daemon/sockets.ts"
import { replaceFile } from "../secrets.ts"
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
 * The office's cookie key, from `officeDir/hq-cookie-key`. The key is part of the session cookie's name, so a page on
 * another port of this host, whose script can neither read an HttpOnly cookie's name nor HQ's replies, can't name
 * HQ's cookie: it can't shadow it with a same-named one at a deeper path or a nameless `=name=value` one. (A server
 * on another port gets the whole Cookie header, the session included, so the key doesn't stop it.)
 *
 * A missing file, or one that isn't a regular file private to this user (mode 0600) holding a key, is replaced by a
 * fresh random key, written atomically; replacing a file that was there signs every browser out, and is logged
 * through `log`. Throws `OfficeStartError` when the file can't be written.
 */
export function cookieKey(officeDir: string, log: (line: string) => void = () => {}): string {
  const file = path.join(officeDir, COOKIE_KEY_FILE)
  const why = readKey(file)
  if (typeof why === "object") return why.key
  const key = randomBytes(16).toString("hex")
  try {
    fs.mkdirSync(officeDir, { recursive: true, mode: 0o700 })
    replaceFile(officeDir, COOKIE_KEY_FILE, `${key}\n`)
  } catch (error) {
    throw new OfficeStartError(`can't write HQ's cookie key ${file}: ${messageOf(error)}`)
  }
  if (why !== "missing") {
    const text = `HQ's cookie key ${file} ${why}; made a new one, so every browser signs in again`
    log(logLine("WARNING", "opencorp.hq.auth", text))
  }
  return key
}

/** The key in `file`, or why there's none: "missing", or what is wrong with the file. */
function readKey(file: string): { key: string } | string {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  let fd: number
  try {
    // O_NONBLOCK so a FIFO there can't hang the open; fstat then refuses it.
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" ? "missing" : `can't be opened (${code})`
  }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.uid !== process.geteuid!() || st.mode & 0o077) return "isn't a private file (mode 0600)"
    const key = fs.readFileSync(fd, "utf8").trim()
    return KEY.test(key) ? { key } : "doesn't hold a key"
  } catch (error) {
    return `can't be read (${(error as NodeJS.ErrnoException).code})`
  } finally {
    fs.closeSync(fd)
  }
}

/** `opencorp_hq_<port>_<key>`, the port being the Host header's (the whole value without a colon) and `key` the
 *  office's cookie key (`cookieKey`): cookies ignore ports, so the port tells HQs on one host apart, and the key keeps
 *  the name unguessable to pages on other ports. */
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
 * office's cookie key). The HQ pipeline is built per request and closes over `req`.
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

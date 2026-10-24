/** The guard on every HQ request, before routing: Host, Fetch Metadata, Origin and body checks, and the security
 *  headers on every response. */
import type { IncomingMessage, OutgoingHttpHeader, OutgoingHttpHeaders, ServerResponse } from "node:http"
import type { ErrorCode } from "@opencorp/protocol"
import { continueIfExpected, nextUnlessAborted, sendError } from "../daemon/http.ts"

/** The page's Content-Security-Policy: no inline script or style, nothing from another origin. */
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
  "connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

/** The headers added to every HQ response, by lower-case name. */
export const HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": CSP,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
}

const SECURITY_NAMES = Object.keys(HEADERS)

/** The largest /api request body; the only writes are pairing and logging out. */
export const MAX_API_BODY = 16 * 1024

/** How long a whole request may take to arrive, in milliseconds: HQ's listeners pass it as `requestTimeout`, so a
 *  client trickling a body can't hold a connection for good. */
export const BODY_TIMEOUT = 10_000

const LOOPBACK = "127.0.0.1"

/** Whether `path` is under /api. */
export function isApi(path: string): boolean {
  return path === "/api" || path.startsWith("/api/")
}

/** The request's first `name` header (lower-case name), or undefined. Read from the raw headers: node:http joins
 *  repeated Origin and Sec-Fetch-Site values with ", ". */
export function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.rawHeaders
  for (let i = 0; i + 1 < raw.length; i += 2) if (raw[i]!.toLowerCase() === name) return raw[i + 1]
  return undefined
}

/** The request target's path without its query, %-decoded: each run of escapes as UTF-8, a run that isn't valid
 *  UTF-8 left as it is (as uvicorn decodes paths). */
export function requestPath(req: IncomingMessage): string {
  const target = req.url ?? ""
  const q = target.indexOf("?")
  const path = q < 0 ? target : target.slice(0, q)
  return path.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run)
    } catch {
      return run
    }
  })
}

/** What HQ serves behind the guard; `body` is an /api write's whole body, read by the guard. */
export type Inner = (req: IncomingMessage, res: ServerResponse, body?: Buffer) => void | Promise<void>

type Refusal = { status: number; code: ErrorCode; message: string } | { location: string }

const isRead = (method: string | undefined) => method === "GET" || method === "HEAD"

const TOO_LARGE = `request body is over ${MAX_API_BODY} bytes`

/** Whether the request's head promises a body (a nonzero Content-Length, or a Transfer-Encoding). */
function declaresBody(req: IncomingMessage): boolean {
  const length = header(req, "content-length")
  return header(req, "transfer-encoding") !== undefined || (length !== undefined && !["", "0"].includes(length.trim()))
}

/** `url` with each character outside Starlette's safe set percent-encoded as UTF-8, as its redirects are. */
function quote(url: string): string {
  return url.replace(/[^A-Za-z0-9\-._~:/%#?=@[\]!$&'()*+,;]/gu, (ch) => encodeURIComponent(ch))
}

/** The response that refuses `req`, or undefined to let it through. */
function refusal(req: IncomingMessage, port: number | null, devOrigins: readonly string[]): Refusal | undefined {
  const target = req.url ?? ""
  if (!target.startsWith("/"))
    // An absolute-form target: its path wouldn't start with /api, so it would skip the API checks.
    return { status: 400, code: "bad_target", message: "HQ takes only origin-form request targets" }
  const host = header(req, "host") ?? ""
  const at = host.lastIndexOf(":")
  const name = at < 0 ? "" : host.slice(0, at)
  const portText = host.slice(at + 1)
  const api = isApi(requestPath(req))
  const portOk = /^[0-9]+$/.test(portText) && (port === null || Number(portText) === port)
  const read = isRead(req.method)
  const dest = header(req, "sec-fetch-dest")
  if (name === "localhost" && portOk && read && !api && (dest === undefined || dest === "document"))
    // Cookies are per host name: send a localhost visit to the one name sessions live on.
    return { location: quote(`http://${LOOPBACK}:${portText}${target}`) }
  if (name !== LOOPBACK || !portOk)
    // A hostname is refused, which blocks DNS rebinding.
    return {
      status: 403,
      code: "host_not_allowed",
      message: `HQ answers only http://${LOOPBACK}:<port>; open that address`,
    }
  if (!api) return undefined
  const site = header(req, "sec-fetch-site")
  if (site !== undefined && site !== "same-origin" && site !== "none")
    // SameSite counts other local ports as the same site; Fetch Metadata tells them apart.
    return { status: 403, code: "cross_site", message: "HQ's API answers only its own pages" }
  const origin = header(req, "origin")
  const allowed = origin === `http://${host}` || (origin !== undefined && devOrigins.includes(origin))
  if ((origin !== undefined && !allowed) || (origin === undefined && !read))
    return { status: 403, code: "origin_not_allowed", message: "HQ's API answers only its own pages" }
  if (!read) {
    const kind = (header(req, "content-type") ?? "").split(";")[0]!.trim().toLowerCase()
    if (kind !== "application/json")
      // No CORS "simple" text/plain or form POST.
      return { status: 415, code: "json_required", message: "HQ's API takes only JSON bodies" }
    const length = header(req, "content-length") ?? ""
    if (/^[0-9]+$/.test(length) && Number(length) > MAX_API_BODY)
      return { status: 413, code: "too_large", message: TOO_LARGE }
  }
  return undefined
}

/** The headers given to `writeHead`, as name and values, a name given twice holding all its values. */
function headerEntries(
  headers: OutgoingHttpHeaders | OutgoingHttpHeader[] | undefined,
): [string, OutgoingHttpHeader][] {
  if (headers === undefined) return []
  if (!Array.isArray(headers))
    return Object.entries(headers).filter((e): e is [string, OutgoingHttpHeader] => e[1] !== undefined)
  // A flat [name, value, name, value] array, or an array of [name, value] pairs.
  const flat = Array.isArray(headers[0]) ? headers.flat() : headers
  const byName = new Map<string, { name: string; values: string[] }>()
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const name = String(flat[i])
    const entry = byName.get(name.toLowerCase()) ?? { name, values: [] }
    entry.values.push(String(flat[i + 1]))
    byName.set(name.toLowerCase(), entry)
  }
  return [...byName.values()].map(({ name, values }) => [name, values.length === 1 ? values[0]! : values])
}

/** The whole body, "too large" once it passes `cap` bytes, or undefined if it ends early: the stream fails or
 *  `signal` aborts (the client left, or the runtime's 408 closed the request). */
async function readCapped(
  req: IncomingMessage,
  cap: number,
  signal: AbortSignal,
): Promise<Buffer | "too large" | undefined> {
  // Chunks are taken by hand, as `readBody` does: leaving a `for await` early destroys the request and its socket,
  // so the 413 would never be sent.
  const it = req[Symbol.asyncIterator]()
  const parts: Buffer[] = []
  let size = 0
  for (;;) {
    let step: IteratorResult<Buffer | string> | undefined
    try {
      step = await nextUnlessAborted(it, signal)
    } catch {
      return undefined
    }
    if (!step) return undefined
    if (step.done) return Buffer.concat(parts)
    const chunk = typeof step.value === "string" ? Buffer.from(step.value) : step.value
    size += chunk.length
    if (size > cap) return "too large"
    parts.push(chunk)
  }
}

/** A `node:http` listener run on every HQ request, static paths and open endpoints included, in front of `inner`;
 *  its promise never rejects. `port` is the TCP listener's bound port, or null on `hq.sock`, where the SSH forward
 *  picks the local port; `devOrigins` are extra origins /api accepts. The server must come from `http.ts`'s
 *  `createServer`, so no `100 Continue` goes out before the checks.
 *
 *  Every response gets `HEADERS`, replacing any of the same names; a response sent while the request's body is
 *  still unread, and every refusal, also closes the connection. `inner` must not call `res.flushHeaders()`: the
 *  headers are set as the head is written. */
export function hqGuard(
  inner: Inner,
  { port, devOrigins = [] }: { port: number | null; devOrigins?: readonly string[] },
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    // A response sent before the body is read leaves the rest of it on the wire, and the connection would read on
    // into it while a client trickles bytes: such a response closes the connection.
    let closing = false
    const writeHead: (this: ServerResponse, status: number, reason?: string) => ServerResponse = res.writeHead
    // An implicit head (`res.end` or `res.write` first) goes through this too.
    res.writeHead = function (
      status: number,
      reason?: string | OutgoingHttpHeaders | OutgoingHttpHeader[],
      headers?: OutgoingHttpHeaders | OutgoingHttpHeader[],
    ) {
      if (typeof reason !== "string") {
        headers = reason
        reason = undefined
      }
      const close = closing || (declaresBody(req) && !req.readableEnded)
      for (const [name, value] of headerEntries(headers)) {
        const key = name.toLowerCase()
        if (!SECURITY_NAMES.includes(key) && !(close && key === "connection")) res.setHeader(name, value)
      }
      for (const name of SECURITY_NAMES) res.removeHeader(name)
      for (const [name, value] of Object.entries(HEADERS)) res.setHeader(name, value)
      if (close) res.setHeader("connection", "close")
      return reason === undefined ? writeHead.call(res, status) : writeHead.call(res, status, reason)
    } as ServerResponse["writeHead"]

    const refused = refusal(req, port, devOrigins)
    if (refused) {
      closing = true
      if ("location" in refused) res.writeHead(307, { location: refused.location, "content-length": "0" }).end()
      else sendError(res, refused.status, refused.code, refused.message)
      return
    }
    let body: Buffer | undefined
    if (isApi(requestPath(req)) && !isRead(req.method)) {
      // Read here, so a chunked body over the cap is refused too; the listener's requestTimeout ends one that
      // stops arriving.
      const controller = new AbortController()
      res.on("close", () => {
        if (!res.writableFinished) controller.abort()
      })
      continueIfExpected(res)
      const read = await readCapped(req, MAX_API_BODY, controller.signal)
      if (read === undefined) return // the client went away; a partial body must never reach a route
      if (read === "too large") {
        closing = true
        return sendError(res, 413, "too_large", TOO_LARGE)
      }
      body = read
    }
    try {
      await inner(req, res, body)
    } catch {
      // Not logged: the inner pipeline logs its own errors, and this guard never logs request input.
      if (!res.headersSent) {
        closing = true
        return sendError(res, 500, "internal_error", "internal error")
      }
      // Bun sends what was written only at the end of the event loop turn, and a destroy before then drops it.
      await new Promise((resolve) => setImmediate(resolve))
      res.destroy()
    }
  }
}

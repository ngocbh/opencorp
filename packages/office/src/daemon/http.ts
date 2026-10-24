/** The office's HTTP pipeline: the route table, how a request target finds its route, how a request body is
 *  read and parsed, and the JSON replies and `ApiError` bodies it sends. */
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http"
import { type ErrorCode, validationMessage } from "@opencorp/protocol"
import type { z } from "zod"
import { NotFound } from "../store/store.ts"

/** A route's path params, decoded. */
export type Params = Record<string, string>

/** What the pipeline knows about a request before routing; the input of the `context` hook. */
export interface RequestInfo {
  /** As sent: HEAD stays HEAD. */
  method: string
  /** The origin-form path, still percent-encoded, without the query. */
  path: string
  query: URLSearchParams
  headers: IncomingHttpHeaders
  /** Aborts when the client goes away before the reply is sent. */
  signal: AbortSignal
}

/** One entry of the route table. */
export interface Route<C> {
  method: "GET" | "POST" | "PUT" | "DELETE"
  /** Literal segments, `:name` (one segment) and `*name` (one or more segments; at most one per path). */
  path: string
  /** GET routes serve HEAD unless this is false. */
  head?: false
  /** Permission and existence checks, run before the body is read. */
  guard?(ctx: C, params: Params): void | Promise<void>
  /** The request body's schema; the body is read after the guard, and the handler gets the parsed value. */
  body?: z.ZodType
  /** The reply schema; its `parse` fills defaults. */
  reply?: z.ZodType
  /** Returns a JSON value or a `RawReply`: `undefined` (without a reply schema) is a 500. */
  handler(ctx: C, params: Params, body: unknown): unknown | Promise<unknown>
}

/** The hooks a pipeline calls. */
export interface PipelineOptions<C> {
  /** Builds the request's context; may throw `HttpError` (e.g. 401). */
  context(info: RequestInfo): C | Promise<C>
  /** Receives whole formatted lines (`logLine`). */
  log(line: string): void
}

/** An error reply: thrown by a hook, a guard or a handler, sent as an `ApiError` body with `status`. */
export class HttpError extends Error {
  override name = "HttpError"

  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** Writes a JSON reply unless the response is already closed; no body for HEAD. A failed write destroys the
 *  response, so it never hangs: the client left, the runtime answered first (its own 408), or the status or
 *  headers are invalid. */
function send(res: ServerResponse, status: number, text: string, headers: Record<string, string>): void {
  if (res.destroyed || res.socket?.destroyed) return
  try {
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(text)),
      ...headers,
    })
    res.end(res.req.method === "HEAD" ? undefined : text)
  } catch {
    res.destroy()
  }
}

/** A reply the handler shapes itself, sent as is (no reply schema): `status`, `headers` (lower-case names), and a
 *  body that is either text, sent whole with its length (`content-type` defaults to `application/json`), or chunks
 *  streamed as they come. A streamed body that waits must end once `ctx.signal` aborts: an async generator can't be
 *  stopped from outside while it awaits. A streamed body should take its resources (a subscription, a file) inside
 *  the generator body, which runs only on the first pull: HEAD, and a client that left before the reply, never
 *  start it. */
export class RawReply {
  constructor(
    readonly status: number,
    readonly headers: Readonly<Record<string, string>>,
    readonly body: string | AsyncIterable<string>,
  ) {}
}

/** Resolves once `res` can take more data or has closed. */
function drained(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    if (res.destroyed) return resolve()
    const done = () => {
      res.off("drain", done)
      res.off("close", done)
      resolve()
    }
    res.on("drain", done)
    res.on("close", done)
  })
}

/** Sends `reply` with `extra` headers added: text whole through `send`, a stream chunk by chunk, waiting while
 *  the client isn't reading. HEAD gets the head only and never starts the stream. An error from the stream
 *  rejects, after the head has gone out. */
async function sendRaw(res: ServerResponse, reply: RawReply, extra: Record<string, string>): Promise<void> {
  const headers = { ...reply.headers, ...extra }
  if (typeof reply.body === "string") return send(res, reply.status, reply.body, headers)
  res.writeHead(reply.status, headers)
  if (res.req.method === "HEAD") {
    res.end()
    return
  }
  for await (const chunk of reply.body) {
    if (res.destroyed) break
    if (!res.write(chunk)) await drained(res)
    // A client that left while we waited must not cost another chunk: for an event stream, one taken and lost.
    if (res.destroyed) break
  }
  if (!res.destroyed) res.end()
}

/** An `ApiError` JSON body. */
function apiError(code: ErrorCode, message: string): string {
  return JSON.stringify({ error: code, message })
}

/** Sends an `ApiError` JSON body (Python's `error`); no body for HEAD; ignored when the response is closed. */
export function sendError(
  res: ServerResponse,
  status: number,
  code: ErrorCode,
  message: string,
  headers: Record<string, string> = {},
): void {
  send(res, status, apiError(code, message), headers)
}

type Segment = { kind: "literal"; text: string } | { kind: "param"; name: string }

interface Pattern<C> {
  route: Route<C>
  /** The segments before the `*name`, or all of them. */
  before: Segment[]
  /** The `*name`'s name, if the path has one. */
  rest?: string
  /** The segments after the `*name`. */
  after: Segment[]
}

function segment(text: string): Segment {
  return text.startsWith(":") ? { kind: "param", name: text.slice(1) } : { kind: "literal", text }
}

function compile<C>(route: Route<C>): Pattern<C> {
  const parts = route.path.split("/")
  const star = parts.findIndex((part) => part.startsWith("*"))
  if (star < 0) return { route, before: parts.map(segment), after: [] }
  return {
    route,
    before: parts.slice(0, star).map(segment),
    rest: parts[star]!.slice(1),
    after: parts.slice(star + 1).map(segment),
  }
}

/** Matches `segments` (decoded) against `pattern`'s fixed segments, filling `params`; false on a mismatch. */
function fixed(pattern: Segment[], segments: string[], params: Params): boolean {
  return pattern.every((seg, i) => {
    const value = segments[i]!
    if (seg.kind === "literal") return value === seg.text
    // A decoded "/" or ".." would let a param name a path outside the one it stands for.
    if (value === "" || value === ".." || value.includes("/")) return false
    params[seg.name] = value
    return true
  })
}

/** The params of `decoded` under `pattern`, or undefined if it doesn't match. */
function match<C>(pattern: Pattern<C>, decoded: string[]): Params | undefined {
  const { before, rest, after } = pattern
  const params: Params = {}
  if (rest === undefined)
    return decoded.length === before.length && fixed(before, decoded, params) ? params : undefined
  const end = decoded.length - after.length
  if (end <= before.length) return undefined
  if (!fixed(before, decoded, params) || !fixed(after, decoded.slice(end), params)) return undefined
  // A %xx can't span a raw "/", so joining the decoded segments equals decoding the joined text once.
  const value = decoded.slice(before.length, end).join("/")
  if (value === "" || value.split("/").includes("..")) return undefined
  params[rest] = value
  return params
}

const ABSOLUTE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/

/** The request target in origin form. A client sends an absolute-form target (`http://host/path`) over a unix
 *  socket when a proxy is set. It isn't parsed with `URL`, which would normalize dot segments and escapes. */
function originForm(target: string): string {
  if (target.startsWith("/")) return target
  const prefix = ABSOLUTE.exec(target)
  if (!prefix) return target
  const rest = target.slice(prefix[0].length)
  return rest === "" || rest.startsWith("?") ? `/${rest}` : rest
}

/** The largest request body the office reads, in bytes. */
export const MAX_BODY = 1 << 20

/** The deepest nesting of arrays and objects a JSON body may have. */
export const MAX_DEPTH = 64

const tooLarge = () => new HttpError(413, "body_too_large", `request body is over ${MAX_BODY} bytes`)
const endedEarly = () => new HttpError(400, "invalid_body", "the body ended early")
const notJson = () => new HttpError(422, "invalid_body", "the body isn't JSON")

/** The iterator's next step, or undefined once `signal` aborts first. */
function nextUnlessAborted<T>(it: AsyncIterator<T>, signal?: AbortSignal): Promise<IteratorResult<T> | undefined> {
  if (!signal) return it.next()
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise((resolve, reject) => {
    const abort = () => resolve(undefined)
    signal.addEventListener("abort", abort, { once: true })
    it.next()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
  })
}

/** Sends `100 Continue` if `res`'s request waits for it, on a server from `createServer` (which never sends it on
 *  its own); not for HTTP/1.0. Call it once, right before reading a body, after every check. */
export function continueIfExpected(res: ServerResponse): void {
  const { headers, httpVersion } = res.req
  // Node's own test of the header.
  if (headers.expect === undefined || !/(?:^|\W)100-continue(?:$|\W)/i.test(headers.expect)) return
  // An HTTP/1.0 client doesn't know 100 (RFC 9110).
  if (httpVersion === "1.0") return
  res.writeContinue()
}

/** The request body. Throws `HttpError` 413 once it passes `MAX_BODY`, reading no further, and 400 when it ends
 *  early: the stream fails, or `signal` aborts (the client left, or the runtime's 408 closed the request). Given
 *  `res`, which must be `req`'s response, it sends `100 Continue` first if the request waits for it, unless the
 *  declared length is too large. */
export async function readBody(
  req: AsyncIterable<Buffer | string> & { headers: IncomingHttpHeaders },
  signal?: AbortSignal,
  res?: ServerResponse,
): Promise<Buffer> {
  const length = req.headers["content-length"]
  if (length !== undefined && /^\d+$/.test(length) && Number(length) > MAX_BODY) throw tooLarge()
  if (res) continueIfExpected(res)
  // Chunks are taken by hand, never with `for await` or `it.return()`: leaving the loop early destroys an
  // unfinished request, and with it the socket on Node, so the 413 would never reach the client. The rest of an
  // oversized body is never drained either; the reply closes the connection instead.
  const it = req[Symbol.asyncIterator]()
  const parts: Buffer[] = []
  let size = 0
  for (;;) {
    let step: IteratorResult<Buffer | string> | undefined
    try {
      step = await nextUnlessAborted(it, signal)
    } catch {
      throw endedEarly()
    }
    if (!step) throw endedEarly()
    if (step.done) break
    const chunk = typeof step.value === "string" ? Buffer.from(step.value) : step.value
    size += chunk.length
    if (size > MAX_BODY) throw tooLarge()
    parts.push(chunk)
  }
  return Buffer.concat(parts)
}

/** Whether `text` (JSON) nests arrays and objects deeper than `MAX_DEPTH`; brackets inside strings don't count. */
function tooDeep(text: string): boolean {
  let depth = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === "\\") i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === "[" || c === "{") {
      if (++depth > MAX_DEPTH) return true
    } else if (c === "]" || c === "}") depth--
  }
  return false
}

/** `buf` as UTF-8 JSON validated by `schema`; `HttpError` 422 when it isn't. The 422 never echoes an input
 *  value or an unknown key's name: the body may hold a key or a password. */
function parseBody(schema: z.ZodType, buf: Buffer): unknown {
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf)
  } catch {
    throw notJson()
  }
  // Checked before parsing, so a deep body never reaches a recursive parse or zod.
  if (tooDeep(text)) throw new HttpError(422, "invalid_body", "the body is nested too deeply")
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw notJson()
  }
  const result = schema.safeParse(data)
  // Only `validationMessage`'s text leaves here: the ZodError and its issues quote unknown keys.
  if (!result.success) throw new HttpError(422, "invalid_body", validationMessage(schema, result.error, data))
  return result.data
}

/** Whether the request carries a body. */
function hasBody(req: IncomingMessage): boolean {
  const length = req.headers["content-length"]
  return "transfer-encoding" in req.headers || (length !== undefined && length !== "0")
}

/** A `node:http` listener that serves `routes` through `options`' hooks; its promise settles once the request is
 *  answered and never rejects (node ignores it, tests await it). */
export function requestListener<C>(
  routes: readonly Route<C>[],
  options: PipelineOptions<C>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const patterns = routes.map(compile)
  return async (req, res) => {
    const controller = new AbortController()
    res.on("close", () => {
      if (!res.writableFinished) controller.abort()
    })
    // The client can leave while a hook, guard or handler awaits; then nothing is sent. `send` also skips a
    // response that is already destroyed.
    const reply = (status: number, text: string, headers: Record<string, string>) => {
      if (!controller.signal.aborted) send(res, status, text, headers)
    }
    const method = req.method ?? "GET"
    let route: Route<C> | undefined
    // Guarded: a throwing log hook must not make the listener reject.
    const logInternal = (error: unknown) => {
      try {
        // The type only: a message (or a settable `.name`) can quote a secret or a request's input.
        const type = error instanceof Error ? error.constructor.name : typeof error
        const where = `${method} ${route?.path ?? "(no route)"}`
        options.log(logLine("ERROR", "opencorp.daemon.http", `internal error on ${where}: ${type}`))
      } catch {}
    }
    // A body left unread, or read only in part, stays on the connection, so it can't be reused: what follows on
    // it would start inside that body. Reading the whole body clears this.
    let unread: Record<string, string> = hasBody(req) ? { connection: "close" } : {}
    try {
      const target = originForm(req.url ?? "/")
      const q = target.indexOf("?")
      const path = q < 0 ? target : target.slice(0, q)
      const query = new URLSearchParams(q < 0 ? "" : target.slice(q + 1))
      const ctx = await options.context({ method, path, query, headers: req.headers, signal: controller.signal })

      let decoded: string[] | undefined
      try {
        decoded = path.split("/").map(decodeURIComponent)
      } catch {} // a malformed escape matches no route
      let params: Params | undefined
      const allowed = new Set<string>()
      if (decoded)
        for (const pattern of patterns) {
          const found = match(pattern, decoded)
          if (!found) continue
          const r = pattern.route
          const head = r.method === "GET" && r.head !== false
          allowed.add(r.method)
          if (head) allowed.add("HEAD")
          if (!route && (r.method === method || (method === "HEAD" && head))) {
            route = r
            params = found
          }
        }
      if (!route) {
        if (allowed.size === 0) return reply(404, apiError("no_route", `no route ${method} ${path}`), unread)
        const allow = [...allowed].sort().join(", ")
        const message = `${method} is not allowed on ${path}`
        return reply(405, apiError("method_not_allowed", message), { allow, ...unread })
      }

      await route.guard?.(ctx, params!)
      // The body is read only after the guard: a refused request is answered without reading a byte of it.
      let body: unknown
      if (route.body) {
        const buf = await readBody(req, controller.signal, res)
        unread = {}
        body = parseBody(route.body, buf)
      }
      const value = await route.handler(ctx, params!, body)
      if (value instanceof RawReply) {
        if (!controller.signal.aborted) await sendRaw(res, value, unread)
        return
      }
      const text = JSON.stringify(route.reply ? route.reply.parse(value) : value) as string | undefined
      if (text === undefined) throw new TypeError("the handler returned no JSON value")
      reply(200, text, unread)
    } catch (error) {
      if (res.headersSent) {
        // No reply can follow a head: the client sees the connection close without the last chunk.
        const left = controller.signal.aborted
        // Bun sends what was written only at the end of the event loop turn, and a destroy before then drops it.
        await new Promise((resolve) => setImmediate(resolve))
        res.destroy()
        if (!left) logInternal(error)
        return
      }
      if (error instanceof HttpError) return reply(error.status, apiError(error.code, error.message), unread)
      // Store messages name ids, never values.
      if (error instanceof NotFound) return reply(404, apiError("not_found", error.message), unread)
      // The client left, so a handler that honours `ctx.signal` and rejects (an AbortError) is neither answered
      // nor logged.
      if (controller.signal.aborted) return
      reply(500, apiError("internal_error", "internal error"), { connection: "close" })
      // After the reply, so a throwing log hook can't leave the client waiting.
      logInternal(error)
    }
  }
}

/** The server's timeouts, checks and connection cap; times in milliseconds. */
export interface Limits {
  connectionsCheckingInterval: number
  headersTimeout: number
  requestTimeout: number
  keepAliveTimeout: number
  /** Past this many open connections a new one is closed at once; no cap when absent. */
  maxConnections?: number
}

/** The office's limits.
 *
 *  - The runtime checks `headersTimeout` and `requestTimeout` only every `connectionsCheckingInterval`, hence 1 s
 *    rather than the 30 s default.
 *  - `requestTimeout` covers receiving the request only: a slow handler's reply isn't cut.
 *  - HQ's listeners pass `{...LIMITS, requestTimeout: 10_000, maxConnections: 64}`. */
export const LIMITS: Readonly<Limits> = {
  connectionsCheckingInterval: 1000,
  headersTimeout: 10_000,
  requestTimeout: 20_000,
  keepAliveTimeout: 4000,
}

/** An HTTP server for `listener` with `limits`; it has no idle socket timeout (`requestTimeout` bounds a
 *  request) and no upgrade listener, so an upgrade request is served as plain HTTP. It never sends `100 Continue`
 *  on its own and serves a request with any `Expect` value: `listener` must call `continueIfExpected` (or
 *  `readBody` with `res`) before it reads a body. */
export function createServer(listener: RequestListener, limits: Limits = LIMITS): http.Server {
  const { maxConnections, ...options } = limits
  const server = http.createServer(options, listener)
  // Otherwise the runtime answers `Expect` before the listener runs: 100 for 100-continue, 417 for anything else.
  // Nothing may go out before the context hook (auth) and the guard; unknown expectations are ignored, as
  // uvicorn did.
  server.on("checkContinue", (req, res) => server.emit("request", req, res))
  server.on("checkExpectation", (req, res) => server.emit("request", req, res))
  // An event stream stays open with long quiet spells, so there is no idle cut.
  server.timeout = 0
  if (maxConnections !== undefined) server.maxConnections = maxConnections
  return server
}

/** A log line's level. */
export type Level = "INFO" | "WARNING" | "ERROR"

/** One formatted log line: `<ISO time> <level> <logger>: <message>`. */
export function logLine(level: Level, logger: string, message: string, at: Date = new Date()): string {
  return `${at.toISOString()} ${level} ${logger}: ${message}`
}

/** The office's HTTP pipeline: the route table, how a request target finds its route, and the JSON replies and
 *  `ApiError` bodies it sends. */
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http"
import type { ErrorCode } from "@opencorp/protocol"
import type { z } from "zod"

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
  /** The request schema; the handler gets the parsed value. */
  body?: z.ZodType
  /** The reply schema; its `parse` fills defaults. */
  reply?: z.ZodType
  /** Returns a JSON value: `undefined` (without a reply schema) is a 500. */
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
    // The client can leave while a hook, guard or handler awaits; then nothing is sent. `send` checks the rest.
    const reply = (status: number, text: string, headers: Record<string, string>) => {
      if (!controller.signal.aborted) send(res, status, text, headers)
    }
    const method = req.method ?? "GET"
    // No route reads its body yet, so a body is always left unread, and the connection can't be reused: what
    // follows on it would start inside that body.
    const unread: Record<string, string> = hasBody(req) ? { connection: "close" } : {}
    let route: Route<C> | undefined
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
      // The body step: a route with a `body` schema would read and parse it here; none does yet, so the handler
      // gets undefined.
      const value = await route.handler(ctx, params!, undefined)
      const text = JSON.stringify(route.reply ? route.reply.parse(value) : value) as string | undefined
      if (text === undefined) throw new TypeError("the handler returned no JSON value")
      reply(200, text, unread)
    } catch (error) {
      if (error instanceof HttpError) return reply(error.status, apiError(error.code, error.message), unread)
      reply(500, apiError("internal_error", "internal error"), { connection: "close" })
      // After the reply, and guarded: a throwing log hook must neither leave the client waiting nor reject.
      try {
        // The type only: a message (or a settable `.name`) can quote a secret or a request's input.
        const type = error instanceof Error ? error.constructor.name : typeof error
        const where = `${method} ${route?.path ?? "(no route)"}`
        options.log(logLine("ERROR", "opencorp.daemon.http", `internal error on ${where}: ${type}`))
      } catch {}
    }
  }
}

/** The server's timeouts and checks, in milliseconds. */
export interface Limits {
  connectionsCheckingInterval: number
  headersTimeout: number
  requestTimeout: number
  keepAliveTimeout: number
}

/** The office's limits. */
export const LIMITS: Limits = {
  connectionsCheckingInterval: 1000,
  headersTimeout: 10_000,
  requestTimeout: 20_000,
  keepAliveTimeout: 4000,
}

/** An HTTP server for `listener` with `limits`; it has no idle socket timeout (`requestTimeout` bounds a
 *  request) and no upgrade listener. */
export function createServer(listener: RequestListener, limits: Limits = LIMITS): http.Server {
  const server = http.createServer(limits, listener)
  server.timeout = 0
  return server
}

/** A log line's level. */
export type Level = "INFO" | "WARNING" | "ERROR"

/** One formatted log line: `<ISO time> <level> <logger>: <message>`. */
export function logLine(level: Level, logger: string, message: string, at: Date = new Date()): string {
  return `${at.toISOString()} ${level} ${logger}: ${message}`
}

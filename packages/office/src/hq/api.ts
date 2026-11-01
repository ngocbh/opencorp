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
  HqLoginRequest,
  PairRequest,
  Person,
  Question,
  RunDetail,
  RunEvent,
  RunEventPage,
  RunNodePage,
  RunPage,
  Session,
  WorkItem,
} from "@opencorp/protocol"
import { z } from "zod"
import { blankSecrets } from "../company/secret_keys.ts"
import { SourceError } from "../company/source.ts"
import {
  HttpError,
  RawReply,
  type RequestInfo,
  type Route,
  errorType,
  logLine,
  requestListener,
} from "../daemon/http.ts"
import { PING } from "../daemon/bus.ts"
import type { RequestContext } from "../daemon/office.ts"
import { costs } from "../daemon/routes/costs.ts"
import { whoami } from "../daemon/routes/devices.ts"
import { RESET, frame } from "../daemon/routes/events.ts"
import { listQuestions } from "../daemon/routes/questions.ts"
import {
  getRun,
  listRuns,
  liveStream,
  liveTarget,
  runEvent,
  runEvents,
  runLog,
  runNodes,
} from "../daemon/routes/runs.ts"
import { listSessions } from "../daemon/routes/sessions.ts"
import { getWorkItem } from "../daemon/routes/work_items.ts"
import { browserAuth, cookieName, cookieValue } from "./auth.ts"
import type { Hq } from "./core.ts"
import { hqGuard, isApi, requestPath } from "./guard.ts"
import { BadCredentials, Busy, Throttled } from "./login.ts"
import type { Who } from "./sessions.ts"
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

/** What HQ's stream carries: sessions, questions, work items, runs and the company. No live transcript events,
 *  profiles, feedback, debriefs, proposals or comments; run logs, which hold some of those, are read through /api/runs
 *  (every signed-in human can read every one). */
export const HQ_EVENT_TYPES: ReadonlySet<string> = new Set([
  "session.created",
  "session.updated",
  "question.created",
  "question.updated",
  "work_item.created",
  "work_item.updated",
  "run.updated",
  "company.updated",
])

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

/** The one answer to every failed sign-in, so nobody can tell which handles exist. */
export const BAD_CREDENTIALS = "wrong handle or password"

/** A JSON error reply the handler shapes itself, with `headers` added. */
function errorReply(status: number, code: ErrorCode, message: string, headers: Record<string, string> = {}): RawReply {
  return new RawReply(status, headers, JSON.stringify({ error: code, message }))
}

/** The last `name` in the query, as Starlette's `query_params.get`; undefined when absent. */
function last(ctx: HqContext, name: string): string | undefined {
  return ctx.query.getAll(name).at(-1)
}

/** Counts a stream against its session (`BrowserSessions.open`); returns the release to call once it ends. A client
 *  that leaves first releases it too: the stream's body then never starts. */
function track(ctx: HqContext, cut: AbortController): () => void {
  const release = ctx.hq.sessions.open(ctx.session!, cut)
  if (ctx.signal.aborted) release()
  else ctx.signal.addEventListener("abort", release, { once: true })
  return () => {
    ctx.signal.removeEventListener("abort", release)
    release()
  }
}

/**
 * Watches session `sid` beside a stream, on its own subscription, so a stream waiting on its client, its log or its
 * worker still learns of each commit: aborts `cut` once the session's person no longer checks out at a new commit, or
 * the check fails (logged as `couldn't re-check ...; ending its <what>`). Returns the stop to call once the stream
 * ends.
 */
function watchSession(hq: Hq, sid: string, cut: AbortController, what: string): () => void {
  const sub = hq.office.bus.subscribe(null, { types: ["company.updated"] })
  let finished = false
  void (async () => {
    for (;;) {
      const item = await sub.next(hq.pingMs)
      if (item === null) {
        // Ended from outside (the office stopping) rather than by the stop: the stream can't be watched any more.
        if (!finished) cut.abort()
        return
      }
      if (item === PING || item[1].type !== "company.updated") continue
      const [, event] = item
      try {
        if (!(await hq.sessions.stillValid(sid, event.subject_id))) return cut.abort()
      } catch (error) {
        // The app reconnects, and its next request checks the session at HEAD again.
        const type = errorType(error)
        const text = `couldn't re-check HQ session ${sid} at ${event.subject_id}; ending its ${what}: ${type}`
        hq.log(logLine("ERROR", "opencorp.hq.api", text))
        return cut.abort()
      }
    }
  })()
  return () => {
    finished = true
    // Wakes the watcher, which then ends.
    sub.end()
  }
}

/**
 * HQ's event stream: the /events contract (`: connected`, frames, `reset`, pings) for HQ's event types.
 *
 * Every frame and ping checks the session's expiry and revocation, and each `company.updated` checks its person
 * again at the new commit; a failing check ends the stream (the app then gets 401 and shows sign-in). `cut` ends it
 * from outside, even while the client isn't reading: a revoke, a commit the watcher refuses, or a bus drop abort it.
 * `done` releases its slot.
 */
async function* hqEvents(ctx: HqContext, cut: AbortController, done: () => void): AsyncGenerator<string> {
  const { hq } = ctx
  const sid = ctx.session!
  if (cut.signal.aborted) return done()
  // Subscribed here, on the first pull, so a reply that never starts leaves no subscription behind.
  const sub = hq.office.bus.subscribe(null, { types: HQ_EVENT_TYPES })
  // A generator can't be stopped from outside while it awaits `next`; ending the subscription wakes it.
  const end = () => sub.end()
  if (ctx.signal.aborted) end()
  else ctx.signal.addEventListener("abort", end, { once: true })
  cut.signal.addEventListener("abort", end, { once: true })
  // A drop while the client isn't reading: only the cut ends it then.
  const dropped = () => cut.abort()
  sub.ended.addEventListener("abort", dropped, { once: true })
  const stopWatching = watchSession(hq, sid, cut, "stream")
  try {
    yield ": connected\n\n"
    while (hq.sessions.alive(sid)) {
      const item = await sub.next(hq.pingMs)
      if (item === null) {
        if (sub.dropped) yield RESET
        return
      }
      if (!hq.sessions.alive(sid)) return
      if (item === PING) {
        yield ": ping\n\n"
        continue
      }
      const [, event] = item
      // Checked here too, not only by the watcher, so no frame goes out after a commit the person fails: neither
      // that commit's own frame nor those published while the watcher's check loads. A check that fails is logged
      // by the watcher, which runs the same check.
      if (event.type === "company.updated" && !(await hq.sessions.stillValid(sid, event.subject_id).catch(() => false)))
        return
      yield frame(item)
    }
  } finally {
    ctx.signal.removeEventListener("abort", end)
    cut.signal.removeEventListener("abort", end)
    sub.ended.removeEventListener("abort", dropped)
    stopWatching()
    done()
    sub.close()
  }
}

/**
 * HQ's live stream of run `runId`: the /runs/{id}/live contract, ended as `hqEvents` ends its stream: when the session
 * is revoked or expires, or its person no longer checks out at a new commit (`cut` aborts). `done` releases its slot.
 */
async function* hqLive(
  ctx: HqContext,
  runId: string,
  log: string,
  after: number,
  cut: AbortController,
  done: () => void,
): AsyncGenerator<string> {
  const { hq } = ctx
  const sid = ctx.session!
  if (cut.signal.aborted) return done()
  // Watched here, on the first pull, so a reply that never starts leaves no subscription behind.
  const stopWatching = watchSession(hq, sid, cut, "live stream")
  try {
    yield* liveStream(hq.office, runId, log, after, {
      signal: AbortSignal.any([ctx.signal, cut.signal]),
      pingMs: hq.pingMs,
      alive: () => hq.sessions.alive(sid),
    })
  } finally {
    stopWatching()
    done()
  }
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
  { method: "GET", path: "/api/sessions", reply: z.array(Session), handler: listSessions },
  { method: "GET", path: "/api/questions", reply: z.array(Question), handler: listQuestions },
  // Run Logs: every signed-in human reads every run, its records and its log as stored.
  { method: "GET", path: "/api/runs", reply: RunPage, handler: listRuns },
  { method: "GET", path: "/api/runs/:id", reply: RunDetail, handler: getRun },
  { method: "GET", path: "/api/runs/:id/nodes", reply: RunNodePage, handler: runNodes },
  { method: "GET", path: "/api/runs/:id/events", reply: RunEventPage, handler: runEvents },
  { method: "GET", path: "/api/runs/:id/events/:seq", reply: RunEvent, handler: runEvent },
  // No HEAD, as on the socket: the handler opens the log. The GET catch-all then answers HEAD with 404.
  { method: "GET", path: "/api/runs/:id/log", head: false, handler: runLog },
  // A run's live stream (`hqLive`); HEAD is refused here, as on /api/events.
  {
    method: "GET",
    path: "/api/runs/:id/live",
    handler: (ctx, params) => {
      if (ctx.req.method !== "GET")
        return errorReply(405, "method_not_allowed", `${ctx.req.method} is not allowed on /api/runs/:id/live`, {
          allow: "GET",
        })
      const { log, after } = liveTarget(ctx, params.id!)
      // Counted from here, not from the body's first pull, so a burst of opens can't pass the cap before any starts.
      const cut = new AbortController()
      const done = track(ctx, cut)
      return new RawReply(
        200,
        { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
        hqLive(ctx, params.id!, log, after, cut, done),
        { abort: cut.signal },
      )
    },
  },
  { method: "GET", path: "/api/work-items/:id", reply: WorkItem, handler: getWorkItem },
  { method: "GET", path: "/api/costs", reply: CostReport, handler: costs },
  // HQ's event stream (`hqEvents`). HEAD is refused here rather than by `head: false`, which would let the GET
  // catch-all answer it with 404: a HEAD reply to a stream that never ends would hold the connection.
  {
    method: "GET",
    path: "/api/events",
    handler: (ctx) => {
      if (ctx.req.method !== "GET")
        return errorReply(405, "method_not_allowed", `${ctx.req.method} is not allowed on /api/events`, {
          allow: "GET",
        })
      // Counted from here, as the live stream is.
      const cut = new AbortController()
      const done = track(ctx, cut)
      return new RawReply(
        200,
        { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
        hqEvents(ctx, cut, done),
        { abort: cut.signal },
      )
    },
  },
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
  // Signs this browser in with a human's handle and password. Open without a session. The session is the one
  // pairing issues, with `via` "login"; the password is never logged.
  {
    method: "POST",
    path: "/api/login",
    body: HqLoginRequest,
    handler: async ({ hq, req }, _params, body) => {
      const { handle, password, label } = body as z.output<typeof HqLoginRequest>
      // HQ listens only on 127.0.0.1 and hq.sock, so the peer is in practice always 127.0.0.1 or "" (hq.sock): the
      // throttle keyed on it is per handle. Anyone who reaches HQ can lock a handle's password sign-in for a while,
      // which is why `opencorp pair` never goes through it and stays the way in.
      const peer = req.socket.remoteAddress ?? ""
      const who = `@${handle} from ${peer || "hq.sock"}`
      const info = (message: string) => hq.log(logLine("INFO", "opencorp.hq.api", message))
      let old: Who | null
      let issued: [BrowserSessionType, string]
      try {
        const checked = await hq.logins.check(peer, handle, password)
        // Only a session the cookie really proves is replaced; a forged or stale cookie revokes nothing.
        old = await hq.sessions.check(cookieValue(req))
        try {
          issued = await hq.sessions.issue(handle, { issuedBy: handle, label, via: "login", checked })
        } catch (e) {
          // HEAD moved since the check.
          if (e instanceof HttpError && (e.code === "not_a_human" || e.code === "password_changed"))
            throw new BadCredentials()
          throw e
        }
      } catch (e) {
        if (e instanceof BadCredentials) {
          info(`sign-in for ${who} failed`)
          return errorReply(401, "bad_credentials", BAD_CREDENTIALS)
        }
        if (e instanceof Throttled) {
          // Once per lock: a client retrying in a loop mustn't flood the log.
          if (e.first) info(`sign-in for ${who} throttled for ${e.retryAfter} s`)
          const minutes = Math.ceil(e.retryAfter / 60)
          const wait = `wait ${minutes} minute${minutes === 1 ? "" : "s"}`
          const message = `too many tries; ${wait}, or run \`opencorp pair\` on the office machine`
          return errorReply(429, "too_many_attempts", message, { "retry-after": String(e.retryAfter) })
        }
        if (e instanceof Busy) return errorReply(503, "busy", "the office is busy; try again", { "retry-after": "1" })
        throw e
      }
      if (old) await hq.sessions.revoke(old.id) // signing in again replaces this browser's session
      info(`sign-in for ${who} ok`)
      return sessionReply(req, ...issued)
    },
  },
  // Ends this browser's session.
  {
    method: "POST",
    path: "/api/logout",
    handler: async ({ hq, req, session }) => {
      await hq.sessions.revoke(session!)
      return new RawReply(200, { "set-cookie": setCookie(req, "", 0) }, JSON.stringify({ ok: true }))
    },
  },
  // Any method, so a wrong method under /api is 404, never 405, as Starlette's catch-all route was.
  ...(["GET", "POST", "PUT", "PATCH", "DELETE"] as const).flatMap((method) =>
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

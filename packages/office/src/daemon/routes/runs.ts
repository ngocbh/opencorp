/** Run Logs routes: the list of runs, one run's children, and one run's page (its header, node attempts, records, one
 *  record and its log), plus GET /runs/{id}/live, which streams a run's records and live frames. Read-only, on the
 *  office socket and HQ's /api allowlist. */
import fs from "node:fs"
import path from "node:path"
import { RunDetail, RunEvent, RunEventPage, RunNodePage, RunPage } from "@opencorp/protocol"
import { lineEvent, logEvents, UnreadableLog } from "../../runs/reader.ts"
import { NoLog, PAGE } from "../../runs/service.ts"
import { NotFound } from "../../store/store.ts"
import { PING } from "../bus.ts"
import { HttpError, type Params, RawReply, type Route } from "../http.ts"
import type { LiveJoin } from "../live.ts"
import type { Office, RequestContext } from "../office.ts"
import { utcTimestamp } from "./costs.ts"
import { PING_MS, RESET } from "./events.ts"

export const RUN_STATUSES: readonly string[] = ["running", "waiting", "idle", "finished", "failed", "interrupted"]
export const MAX_LIMIT = 200
export const SEQ_MAX = 2 ** 62

/** Query parameter `name`: its last value, as Starlette's `query_params.get`. */
function param(ctx: RequestContext, name: string): string | undefined {
  return ctx.query.getAll(name).at(-1)
}

/** `raw` as an integer from `low` to `high` (`fallback` when absent); 422 otherwise, never quoting it. */
export function intParam<F extends number | null>(
  raw: string | undefined,
  name: string,
  low: number,
  high: number,
  fallback: F,
): number | F {
  if (raw === undefined) return fallback
  // ASCII digits only (Number also takes signs, spaces, exponents and hex), at most 9 of them: always a safe
  // integer, and never over 2^62, which isn't one.
  const value = /^[0-9]{1,9}$/.test(raw) ? Number(raw) : low - 1
  if (value < low || value > high) {
    // BigInt prints 2^62 exactly.
    throw new HttpError(422, "invalid_body", `${name} must be an integer from ${low} to ${BigInt(high)}`)
  }
  return value
}

/** `?status=`, a comma-separated list of run statuses (none when absent or empty); 422 on an unknown one. */
export function statuses(raw: string | undefined): string[] {
  if (!raw) return []
  const found = raw.split(",")
  if (found.some((status) => !RUN_STATUSES.includes(status))) {
    throw new HttpError(422, "invalid_body", `status must be a comma-separated list of ${RUN_STATUSES.join(", ")}`)
  }
  return found
}

/** `raw`, an ISO-8601 time with an offset, as a Timestamp; null when absent or empty. */
export function timeParam(raw: string | undefined, name: string): string | null {
  return raw ? utcTimestamp(raw, name) : null
}

/** Top-level runs, newest first, each with how many runs it started; `?parent=<run_id>` lists that run's children
 *  instead. Both filter by `flow`, `person`, `status` (any of a comma-separated list), `q` (any part of a run id)
 *  and launch time (`since` inclusive, `until` exclusive), or `recent` (open runs of any age and runs launched since
 *  then, the list's default), `limit` at a time after `before`. */
export function listRuns(ctx: RequestContext): RunPage {
  // An empty value is no filter.
  const text = (name: string) => param(ctx, name) || null
  const filters = {
    flow: text("flow"),
    person: text("person"),
    status: statuses(param(ctx, "status")),
    q: text("q"),
    since: timeParam(param(ctx, "since"), "since"),
    until: timeParam(param(ctx, "until"), "until"),
    recent: timeParam(param(ctx, "recent"), "recent"),
    before: text("before"),
    limit: intParam(param(ctx, "limit"), "limit", 1, MAX_LIMIT, PAGE),
  }
  if (filters.recent && (filters.since || filters.until)) {
    throw new HttpError(422, "invalid_body", "recent can't be combined with since or until")
  }
  const parent = text("parent")
  if (parent === null) return ctx.office.runs.page(filters)
  try {
    return ctx.office.runs.children(parent, filters)
  } catch (error) {
    if (error instanceof NotFound) throw new HttpError(404, "not_found", `no run ${parent}`)
    throw error
  }
}

/** A run page read; its expected failures become API errors (anything else is a 500, as it should be). */
async function runCall<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof NoLog || (error as { code?: unknown } | null)?.code === "ENOENT") {
      throw new HttpError(404, "no_log", "this run has no log: it didn't start, or its log is gone")
    }
    // Store and reader messages name ids, never values or the log's text.
    if (error instanceof NotFound) throw new HttpError(404, "not_found", error.message)
    // An unknown or retired schema, a line that isn't a record, seqs out of order.
    if (error instanceof UnreadableLog) throw new HttpError(409, "unsupported_schema", error.message)
    throw error
  }
}

/** One run's header: its summary, parent, children, fingerprint, pinned commit, models, usage and log state. */
export function getRun(ctx: RequestContext, params: Params): Promise<RunDetail> {
  return runCall(() => ctx.office.runs.detail(params.id!))
}

/** A run's node attempts, newest start first, `limit` (at most 1,000) at a time from `before`. */
export function runNodes(ctx: RequestContext, params: Params): Promise<RunNodePage> {
  const before = intParam(param(ctx, "before"), "before", 0, SEQ_MAX, null)
  const limit = intParam(param(ctx, "limit"), "limit", 1, 1000, 1000)
  return runCall(() => ctx.office.runs.nodes(params.id!, { before, limit }))
}

/** A run's records after seq `after`: at most `limit` (500) or 256 KiB. */
export function runEvents(ctx: RequestContext, params: Params): Promise<RunEventPage> {
  const after = intParam(param(ctx, "after"), "after", 0, SEQ_MAX, null)
  const limit = intParam(param(ctx, "limit"), "limit", 1, 500, 500)
  return runCall(() => ctx.office.runs.events(params.id!, { after, limit }))
}

/** One record of a run by seq. */
export function runEvent(ctx: RequestContext, params: Params): Promise<RunEvent> {
  const seq = intParam(params.seq, "seq", 0, SEQ_MAX, 0)
  return runCall(() => ctx.office.runs.event(params.id!, seq))
}

/** A run's whole log as stored, as a JSONL attachment no cache keeps. The log is opened before the reply, so a run
 *  without one, or whose log went meanwhile, is a 404 rather than a cut-off download. */
export async function runLog(ctx: RequestContext, params: Params): Promise<RawReply> {
  const runId = params.id!
  const stream = await runCall(() => ctx.office.runs.log(runId))
  // A body never pulled (the client left before the reply) never runs its `finally`, so this closes the file then.
  if (ctx.signal.aborted) stream.destroy()
  else ctx.signal.addEventListener("abort", () => stream.destroy(), { once: true })
  async function* chunks(): AsyncGenerator<Uint8Array> {
    try {
      for await (const chunk of stream) yield chunk as Uint8Array
    } finally {
      stream.destroy()
    }
  }
  // runId is a stored run's id (the lookup above found it), so it is safe in the header.
  const headers = {
    "content-type": "application/x-ndjson",
    "content-disposition": `attachment; filename="${runId}.jsonl"`,
    "cache-control": "no-store",
  }
  return new RawReply(200, headers, chunks())
}

/** Milliseconds between joins while the relay rebuilds its view of a run. */
export const REJOIN_MS = 50

/** Records sent between two yields to the event loop, so a long log doesn't hold the office. */
const BATCH = 64

/**
 * The log of run `id` and the last seq the client already has (`after`, -1 without one): 422 `invalid_body` when
 * `after` isn't a seq, 404 `not_found` when the store holds no such run (or not its session), 404 `no_log` when the
 * run has no log file. The id is looked up in the store before it is joined into a path.
 */
export function liveTarget(ctx: RequestContext, id: string): { log: string; after: number } {
  const raw = param(ctx, "after")
  let after = -1
  if (raw !== undefined) {
    after = Number(raw)
    if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(after))
      throw new HttpError(422, "invalid_body", "after must be a record seq from 0")
  }
  const { store, paths } = ctx.office
  const row = store.getRun(id)
  if (row === undefined || store.getSession(row.sessionId) === undefined)
    throw new HttpError(404, "not_found", `no run ${id}`)
  const log = path.join(paths.runs, row.runId, "log.jsonl")
  if (!fs.statSync(log, { throwIfNoEntry: false })?.isFile())
    throw new HttpError(404, "no_log", "this run has no log: it didn't start, or its log is gone")
  return { log, after }
}

/** One SSE frame of event `type` with `data` as its JSON. */
function liveFrame(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function rest(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done)
  })
}

/**
 * The live stream of run `runId`, whose log is `log`, for a client that has its records through seq `after` (-1 for
 * none). It sends `: connected`, then:
 *
 * - with no worker feeding the run: a `record` frame for each record of the log after `after`, then `run_end`;
 * - with one: the log's records after `after` through the seq the relay's view of the run stands at, a `call` frame
 *   for each model call in flight with its text so far, then each frame the view applies (`record`, `start`, `chunk`,
 *   `end`; a merged chunk carries its last chunk's index) and `: ping` after `pingMs` idle. When the worker ends it
 *   sends the log after the last record sent, then `run_end`. While the relay rebuilds its view the stream joins
 *   again every `REJOIN_MS`, with `: ping` after each `pingMs` of waiting.
 *
 * `run_end` means the worker ended, not the run: a client reconnects with `after` when the run runs again. `reset`
 * means the stream can't go on as the view says (a line that doesn't read as its seq, a log behind the view, a record
 * past the next seq, a viewer the relay dropped): the client reconnects. Any of these ends the stream, as do `signal`
 * aborting and `alive` turning false (checked before every frame).
 */
export async function* liveStream(
  office: Office,
  runId: string,
  log: string,
  after: number,
  { signal, pingMs, alive = () => true }: { signal: AbortSignal; pingMs: number; alive?: () => boolean },
): AsyncGenerator<string> {
  const open = () => !signal.aborted && alive()
  if (!open()) return
  yield ": connected\n\n"
  let last = after
  // A reconnect starts near `after` from the run's index (the run page has usually built it), not by skipping lines
  // from byte 0 in one synchronous read; a stream from the start reads from byte 0 anyway, and so does a reconnect
  // when the log's index can't be read (`logIndex` is null). Built alongside the join, so a long build doesn't hold
  // the rejoin loop's pings.
  const indexing = after >= 0 ? office.runs.logIndex(log) : null
  /** Record frames for the log's records after `last` through `to` (to its end when null); whether the stream goes
   *  on: false once it is closed or has sent `reset`. */
  async function* records(to: number | null): AsyncGenerator<string, boolean> {
    let sent = 0
    const index = await indexing
    for (const event of logEvents(log, last + 1, to, index)) {
      if (++sent % BATCH === 0) await new Promise((resolve) => setImmediate(resolve))
      if (!open()) return false
      if (event === null) {
        yield RESET
        return false
      }
      yield liveFrame("record", { seq: event.seq, record: event })
      last = event.seq
    }
    return open()
  }

  let joined: LiveJoin | "rebuilding" | null = office.live?.join(runId) ?? null
  // A rebuild is normally one follow round trip, but a client still gets a ping per `pingMs` if it drags on.
  let waited = 0
  while (joined === "rebuilding") {
    await rest(REJOIN_MS, signal)
    if (!open()) return
    waited += REJOIN_MS
    if (waited >= pingMs) {
      waited = 0
      yield ": ping\n\n"
    }
    joined = office.live?.join(runId) ?? null
  }
  if (joined === null) {
    if (yield* records(null)) yield liveFrame("run_end", {})
    return
  }
  const { lastSeq, calls, viewer } = joined
  // Wakes a viewer.next() that waits, so a client that leaves doesn't hold the stream until the next ping.
  const close = () => viewer.close()
  signal.addEventListener("abort", close)
  try {
    if (!(yield* records(lastSeq))) return
    if (last < lastSeq) {
      // The log is behind the view.
      yield RESET
      return
    }
    for (const { node, n, text, nextIndex } of calls) {
      if (!open()) return
      yield liveFrame("call", { node, n, text, next_index: nextIndex })
    }
    for (;;) {
      const item = await viewer.next(pingMs)
      if (!open()) return
      if (item === null) {
        if (viewer.dropped) yield RESET
        return
      }
      if (item === PING) {
        yield ": ping\n\n"
        continue
      }
      switch (item.type) {
        case "record": {
          if (item.seq <= last) continue
          const event = item.seq === last + 1 ? lineEvent(Buffer.from(item.line, "utf8"), item.seq) : null
          if (event === null) {
            yield RESET
            return
          }
          yield liveFrame("record", { seq: event.seq, record: event })
          last = item.seq
          break
        }
        case "start": {
          const { node, n, model, purpose, started_at } = item
          yield liveFrame("start", { node, n, model, purpose, started_at })
          break
        }
        case "chunk": {
          const { node, n, index, text } = item
          yield liveFrame("chunk", { node, n, index, text })
          break
        }
        case "end": {
          const { node, n, error } = item
          yield liveFrame("end", { node, n, error })
          break
        }
        case "run_end":
          if (yield* records(null)) yield liveFrame("run_end", {})
          return
      }
    }
  } finally {
    signal.removeEventListener("abort", close)
    viewer.close()
  }
}

/** `liveStream` for the socket, ended (`cut` aborted) once the request's token stops counting. */
async function* trackedLive(
  ctx: RequestContext,
  runId: string,
  log: string,
  after: number,
  pingMs: number,
  cut: AbortController,
): AsyncGenerator<string> {
  // Tracked here, on the first pull, so a reply that never starts leaves nothing tracked.
  const untrack = ctx.office.tokens.track(ctx, () => cut.abort())
  try {
    yield* liveStream(ctx.office, runId, log, after, { signal: AbortSignal.any([ctx.signal, cut.signal]), pingMs })
  } finally {
    untrack()
  }
}

/** `GET /runs/{id}/live[?after=<seq>]`: the run's records and its worker's live frames as SSE (`liveStream`), pinging
 *  after `pingMs` idle, and ended once the request's device is removed. HEAD is refused (405): a HEAD reply to a
 *  stream would hold the connection. */
function live(pingMs: number): Route<RequestContext> {
  return {
    method: "GET",
    path: "/runs/:id/live",
    head: false,
    handler: (ctx, params) => {
      const { log, after } = liveTarget(ctx, params.id!)
      const cut = new AbortController()
      return new RawReply(
        200,
        { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
        trackedLive(ctx, params.id!, log, after, pingMs, cut),
        { abort: cut.signal },
      )
    },
  }
}

/** The run routes, the live stream pinging after `pingMs` idle. */
export function runRoutes(pingMs: number = PING_MS): Route<RequestContext>[] {
  return [
    { method: "GET", path: "/runs", reply: RunPage, handler: listRuns },
    { method: "GET", path: "/runs/:id", reply: RunDetail, handler: getRun },
    { method: "GET", path: "/runs/:id/nodes", reply: RunNodePage, handler: runNodes },
    { method: "GET", path: "/runs/:id/events", reply: RunEventPage, handler: runEvents },
    { method: "GET", path: "/runs/:id/events/:seq", reply: RunEvent, handler: runEvent },
    // No HEAD: a handler can't tell it from GET, and this one opens the log.
    { method: "GET", path: "/runs/:id/log", head: false, handler: runLog },
    live(pingMs),
  ]
}

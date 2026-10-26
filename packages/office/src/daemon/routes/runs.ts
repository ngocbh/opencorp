/** The run routes: GET /runs/{id}/live streams a run's records and live frames; the others answer 501
 *  not_implemented until the run views land. */
import fs from "node:fs"
import path from "node:path"
import { lineEvent, logEvents } from "../../runs/reader.ts"
import { PING } from "../bus.ts"
import { HttpError, RawReply, type Route } from "../http.ts"
import type { LiveJoin, ViewerFrame } from "../live.ts"
import type { Office, RequestContext } from "../office.ts"
import { PING_MS, RESET } from "./events.ts"

/** Milliseconds between joins while the relay rebuilds its view of a run. */
export const REJOIN_MS = 50

/** Records sent between two yields to the event loop, so a long log doesn't hold the office. */
const BATCH = 64

const PATHS = [
  "/runs",
  "/runs/:id",
  "/runs/:id/nodes",
  "/runs/:id/events",
  "/runs/:id/events/:seq",
  "/runs/:id/log",
] as const

/**
 * The log of run `id` and the last seq the client already has (`after`, -1 without one): 422 `invalid_body` when
 * `after` isn't a seq, 404 `not_found` when the store holds no such run (or not its session), 404 `no_log` when the
 * run has no log file. The id is looked up in the store before it is joined into a path.
 */
export function liveTarget(ctx: RequestContext, id: string): { log: string; after: number } {
  const raw = ctx.query.getAll("after").at(-1)
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
 *   again every `REJOIN_MS`.
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
  /** Record frames for the log's records after `last` through `to` (to its end when null); whether the stream goes
   *  on: false once it is closed or has sent `reset`. */
  async function* records(to: number | null): AsyncGenerator<string, boolean> {
    let sent = 0
    for (const event of logEvents(log, last + 1, to)) {
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
  while (joined === "rebuilding") {
    await rest(REJOIN_MS, signal)
    if (!open()) return
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
      const item: ViewerFrame | typeof PING | null = await viewer.next(pingMs)
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

/** `GET /runs/{id}/live[?after=<seq>]`: the run's records and its worker's live frames as SSE (`liveStream`), pinging
 *  after `pingMs` idle. HEAD is refused (405): a HEAD reply to a stream would hold the connection. */
function live(pingMs: number): Route<RequestContext> {
  return {
    method: "GET",
    path: "/runs/:id/live",
    head: false,
    handler: (ctx, params) => {
      const { log, after } = liveTarget(ctx, params.id!)
      return new RawReply(
        200,
        { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
        liveStream(ctx.office, params.id!, log, after, { signal: ctx.signal, pingMs }),
      )
    },
  }
}

/** The run routes, the live stream pinging after `pingMs` idle. A stub's message names the route pattern because a
 *  handler can't see its request path. */
export function runRoutes(pingMs: number = PING_MS): Route<RequestContext>[] {
  return [
  ...PATHS.map((path) => ({
    method: "GET" as const,
    path,
    handler: () => {
      throw new HttpError(501, "not_implemented", `GET ${path} is not implemented yet`)
    },
  })),
  live(pingMs),
  ]
}

/** The run routes: GET /runs/{id}/live streams a run's records; the others answer 501 not_implemented until the run
 *  views land. */
import fs from "node:fs"
import path from "node:path"
import { logEvents } from "../../runs/reader.ts"
import { HttpError, RawReply, type Route } from "../http.ts"
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

/** The relay's view of the worker feeding run `runId`; null when no worker feeds it. */
function join(_office: Office, _runId: string): null {
  // The relay joins here once the office holds one; until then no run has a worker to join.
  return null
}

/** One SSE frame of event `type` with `data` as its JSON. */
function liveFrame(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * The live stream of run `runId`: `: connected`, then, with no worker feeding the run, a `record` frame for each
 * record of `log` after seq `after` and `run_end`. A line that doesn't read as its seq sends `reset` instead. It ends
 * when `signal` aborts or `alive` turns false.
 */
export async function* liveStream(
  office: Office,
  runId: string,
  log: string,
  after: number,
  { signal, alive = () => true }: { signal: AbortSignal; pingMs: number; alive?: () => boolean },
): AsyncGenerator<string> {
  const open = () => !signal.aborted && alive()
  if (!open()) return
  yield ": connected\n\n"
  if (join(office, runId) === null) {
    let sent = 0
    for (const event of logEvents(log, after + 1, null)) {
      if (++sent % BATCH === 0) await new Promise((resolve) => setImmediate(resolve))
      if (!open()) return
      if (event === null) {
        yield RESET
        return
      }
      yield liveFrame("record", { seq: event.seq, record: event })
    }
    if (!open()) return
    yield liveFrame("run_end", {})
  }
}

/** `GET /runs/{id}/live[?after=<seq>]`: the run's records as SSE (`liveStream`). HEAD is refused (405): a HEAD reply
 *  to a stream would hold the connection. */
const LIVE: Route<RequestContext> = {
  method: "GET",
  path: "/runs/:id/live",
  head: false,
  handler: (ctx, params) => {
    const { log, after } = liveTarget(ctx, params.id!)
    return new RawReply(
      200,
      { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
      liveStream(ctx.office, params.id!, log, after, { signal: ctx.signal, pingMs: PING_MS }),
    )
  },
}

/** The run routes. A stub's message names the route pattern because a handler can't see its request path. */
export const ROUTES: readonly Route<RequestContext>[] = [
  ...PATHS.map((path) => ({
    method: "GET" as const,
    path,
    handler: () => {
      throw new HttpError(501, "not_implemented", `GET ${path} is not implemented yet`)
    },
  })),
  LIVE,
]

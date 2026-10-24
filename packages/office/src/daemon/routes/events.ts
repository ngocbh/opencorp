/** The event stream: stored metadata events and live transcript events, as SSE. */
import { type Item, PING } from "../bus.ts"
import { RawReply, type Route } from "../http.ts"
import type { RequestContext } from "../office.ts"

/** Milliseconds of silence before a `: ping` comment keeps the stream open. */
export const PING_MS = 15_000

// The empty data field makes standard SSE parsers (EventSource included) dispatch the event; one with no data
// field at all is silently skipped.
export const RESET = "event: reset\ndata:\n\n"

/** One SSE frame; `meta` frames carry the event id. */
export function frame([kind, event]: Item): string {
  const id = kind === "meta" ? `id: ${event.id}\n` : ""
  return `event: ${kind}\n${id}data: ${JSON.stringify(event)}\n\n`
}

/** The stream's chunks: `: connected`, then frames, pings and a final `reset` if the bus dropped it. */
async function* stream(ctx: RequestContext, pingMs: number): AsyncGenerator<string> {
  // Subscribed before ": connected" is sent, so a client gets every event published after it sees that line.
  // Subscribing here, on the first pull, means a reply that never starts leaves no subscription behind.
  const sub = ctx.office.bus.subscribe(ctx.query.getAll("session").at(-1) ?? null)
  // A generator can't be stopped from outside while it awaits `next`; ending the subscription wakes it.
  const end = () => sub.end()
  if (ctx.signal.aborted) end()
  else ctx.signal.addEventListener("abort", end, { once: true })
  try {
    yield ": connected\n\n"
    for (;;) {
      const item = await sub.next(pingMs)
      if (item === null) {
        if (sub.dropped) yield RESET
        return
      }
      yield item === PING ? ": ping\n\n" : frame(item)
    }
  } finally {
    ctx.signal.removeEventListener("abort", end)
    sub.close()
  }
}

/**
 * `GET /events[?session=<id>]`: bus events, optionally for one session, with a `: ping` after `pingMs` of silence.
 * HEAD is refused (405): a HEAD reply to a stream that never ends would hold the connection.
 *
 * There is no replay, so a client bootstraps in this order: open `/events`, wait for `: connected`, GET the state
 * it needs, then apply the events buffered since `: connected`, in order. A buffered event the snapshot already
 * reflects is harmless to apply: applying them all in order ends at the latest state.
 *
 * `part.delta` only appends text. A client that joined mid-stream ignores deltas for a part until it has that part
 * from a `part.updated` or `message.updated` received after its snapshot.
 *
 * `event: reset` means the office dropped this client for falling behind; the stream then ends, and the client
 * reconnects and bootstraps again. Any other end of the stream (the office stopping) also calls for a fresh
 * bootstrap.
 */
export function eventRoutes(pingMs: number = PING_MS): Route<RequestContext>[] {
  return [
    {
      method: "GET",
      path: "/events",
      head: false,
      handler: (ctx) =>
        new RawReply(
          200,
          { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
          stream(ctx, pingMs),
        ),
    },
  ]
}

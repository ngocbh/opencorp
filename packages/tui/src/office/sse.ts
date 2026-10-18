import type { Event, LiveEvent } from "@opencorp/protocol"
import { UnknownDevice } from "./errors"
import { authorization, BASE } from "./http"

export type SseMessage = { event?: string; id?: string; data: string }

/** An incremental text/event-stream parser: feed bytes as they arrive, in any split. */
export function createParser(onMessage: (m: SseMessage) => void, onComment: (text: string) => void = () => {}) {
  const decoder = new TextDecoder()
  let buf = ""
  let event: string | undefined
  let id: string | undefined
  let data: string[] = []
  const line = (l: string) => {
    if (l === "") {
      if (data.length) onMessage({ ...(event && { event }), ...(id && { id }), data: data.join("\n") })
      event = id = undefined
      data = []
      return
    }
    if (l.startsWith(":")) return onComment(l.slice(1).trimStart())
    const i = l.indexOf(":")
    const field = i < 0 ? l : l.slice(0, i)
    const value = i < 0 ? "" : l.slice(i + 1).replace(/^ /, "")
    if (field === "event") event = value
    else if (field === "id") id = value
    else if (field === "data") data.push(value)
  }
  return {
    feed(chunk: Uint8Array) {
      buf += decoder.decode(chunk, { stream: true })
      let at: number
      while ((at = buf.search(/\r\n|\r|\n/)) >= 0) {
        // A lone \r at the end of the buffer may be the first half of \r\n: wait for more.
        if (buf[at] === "\r" && at + 1 === buf.length) break
        const nl = buf[at] === "\r" && buf[at + 1] === "\n" ? 2 : 1
        line(buf.slice(0, at))
        buf = buf.slice(at + nl)
      }
    },
  }
}

export type StreamEvent =
  /** A stream opened: re-read state now, since there is no replay. */
  | { type: "connected" }
  /** A connected stream ended; reconnecting. */
  | { type: "disconnected"; error?: unknown }
  /** A connect attempt failed (reported once per run of failures). */
  | { type: "unreachable"; error?: unknown }
  | { type: "meta"; id: string; event: Event }
  | { type: "live"; event: LiveEvent }

export type SubscribeOptions = {
  /** Only this session's events (the office's `?session=`). */
  session?: string
  /** The first reconnect delay; it doubles up to `maxDelayMs`. */
  minDelayMs?: number
  maxDelayMs?: number
  /** Silence after which the stream counts as dead. */
  idleMs?: number
  /** This device's token, sent as `Authorization: Bearer`. */
  token?: string
}

export type Subscription = {
  /** Stops following the stream. */
  close(): void
  /**
   * Drops the current stream because it couldn't be used (its bootstrap failed) and
   * reconnects after the backoff delay, which keeps doubling while this repeats.
   */
  reconnect(): void
}

/** Follows the office's event stream on `socket`, reconnecting until `close()`. */
export function subscribe(
  socket: string,
  handler: (e: StreamEvent) => void,
  opts: SubscribeOptions = {},
): Subscription {
  const { minDelayMs = 250, maxDelayMs = 5000, idleMs = 45_000 } = opts
  const path = "/events" + (opts.session ? `?session=${encodeURIComponent(opts.session)}` : "")
  let closed = false
  let ctl: AbortController | undefined
  let wake: (() => void) | undefined
  let backoff: ReturnType<typeof setTimeout> | undefined
  // Set by reconnect(): the stream ended because the caller couldn't use it.
  let unusable = false

  function sleep(ms: number) {
    return new Promise<void>((r) => {
      wake = r
      backoff = setTimeout(r, ms)
    })
  }

  async function once(): Promise<{ error?: unknown; reset: boolean; connected: boolean }> {
    const abort = (ctl = new AbortController())
    let timer: ReturnType<typeof setTimeout> | undefined
    let reset = false
    let connected = false
    // The office pings every 15 s; three missed pings mean the stream is dead even if the
    // socket is still open.
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => abort.abort(), idleMs)
    }
    const parser = createParser(
      (m) => {
        if (m.event === "reset") {
          reset = true
          return abort.abort()
        }
        if (m.event !== "meta" && m.event !== "live") return
        let data: unknown
        try {
          data = JSON.parse(m.data)
        } catch {
          return
        }
        // Everything downstream dispatches on `type`.
        if (!data || typeof data !== "object" || typeof (data as { type?: unknown }).type !== "string") return
        if (m.event === "meta") handler({ type: "meta", id: m.id ?? (data as Event).id, event: data as Event })
        else handler({ type: "live", event: data as LiveEvent })
      },
      (c) => {
        if (c === "connected") {
          connected = true
          handler({ type: "connected" })
        } else if (c === "dropped") {
          reset = true
          abort.abort()
        }
      },
    )
    try {
      arm()
      const res = await fetch(BASE + path, {
        unix: socket,
        signal: abort.signal,
        headers: { accept: "text/event-stream", ...authorization(opts.token) },
      })
      if (res.status === 401) return { error: new UnknownDevice("unauthenticated"), reset, connected }
      if (!res.ok || !res.body) return { error: new Error(`GET ${path}: HTTP ${res.status}`), reset, connected }
      const reader = res.body.getReader()
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        arm()
        parser.feed(r.value)
      }
      return { reset, connected }
    } catch (error) {
      return { error, reset, connected }
    } finally {
      clearTimeout(timer)
    }
  }

  void (async () => {
    let delay = minDelayMs
    let reachable = true // so the first failed attempt reports `unreachable`
    let resets = 0 // streams in a row that ended in a reset
    while (!closed) {
      unusable = false
      const opened = Date.now()
      const { error, reset, connected } = await once()
      if (closed) break
      if (connected) {
        reachable = true
        handler({ type: "disconnected", error })
        if (unusable) resets = 0
        else {
          // A stream that stayed up a while starts a fresh run of retries.
          if (Date.now() - opened >= maxDelayMs) {
            delay = minDelayMs
            resets = 0
          }
          if (!reset) {
            delay = minDelayMs
            resets = 0
          } else if (++resets < 2) {
            // The office is up and only dropped this subscriber: reconnect at once. An
            // office that keeps dropping us gets the backoff.
            continue
          }
        }
      } else if (reachable) {
        reachable = false
        handler({ type: "unreachable", error })
      }
      await sleep(delay)
      delay = Math.min(delay * 2, maxDelayMs)
    }
  })()

  return {
    close() {
      closed = true
      ctl?.abort()
      clearTimeout(backoff)
      wake?.()
    },
    reconnect() {
      unusable = true
      ctl?.abort()
    },
  }
}

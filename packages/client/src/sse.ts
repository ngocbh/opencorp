import type {
  Event,
  LiveEvent,
  RunEvent,
  RunLiveCall,
  RunLiveChunk,
  RunLiveEnd,
  RunLiveStart,
} from "@opencorp/protocol"
import { failureKind, OfficeError, UnknownDevice } from "./errors"
import { authorization, officeFetch, transportOf, type Transport } from "./http"

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
  /** A connect attempt failed (reported once per run of failures of one kind; see `failureKind`). */
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

/** Follows the office's event stream over `target` (a socket path or a transport), reconnecting until `close()`. */
export function subscribe(
  target: string | Transport,
  handler: (e: StreamEvent) => void,
  opts: SubscribeOptions = {},
): Subscription {
  const { minDelayMs = 250, maxDelayMs = 5000, idleMs = 45_000 } = opts
  const t = transportOf(target)
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
      const res = await officeFetch(t, path, {
        signal: abort.signal,
        headers: { accept: "text/event-stream", ...authorization(opts.token) },
      })
      if (res.status === 401)
        return { error: new UnknownDevice("unauthenticated", t.baseUrl !== undefined), reset, connected }
      if (!res.ok || !res.body)
        return { error: new OfficeError(res.status, "bad_response", `GET ${path}: HTTP ${res.status}`), reset, connected }
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
    // The kind of the last failure reported; undefined while connected, so the first failed attempt reports.
    let reported: string | undefined
    let resets = 0 // streams in a row that ended in a reset
    while (!closed) {
      unusable = false
      const opened = Date.now()
      const { error, reset, connected } = await once()
      if (closed) break
      if (connected) {
        reported = undefined
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
      } else if (failureKind(error) !== reported) {
        // Network failures report once per run; an answer that changes (an office back up but refusing this
        // device, say) reports again, or the client would keep showing the first failure.
        reported = failureKind(error)
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

/** A frame of a run's live stream (`GET /runs/{id}/live`), or how the stream ended. */
export type RunLiveFrame =
  | { type: "record"; seq: number; record: RunEvent }
  | ({ type: "call" } & RunLiveCall)
  | ({ type: "start" } & RunLiveStart)
  | ({ type: "chunk" } & RunLiveChunk)
  | ({ type: "end" } & RunLiveEnd)
  /** The run's worker ended: reconnect when the run runs again. */
  | { type: "run_end" }
  /** The office can't go on with this stream: reconnect. */
  | { type: "reset" }
  /**
   * The stream ended or failed without `run_end` or `reset`: an `OfficeError` for a refused status, `UnknownDevice`
   * for a 401.
   */
  | { type: "closed"; error?: unknown }

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const isText = (v: unknown): v is string => typeof v === "string"
const isTextOrNull = (v: unknown) => v === null || isText(v)

/** Whether `d` has the fields frame `event` carries, as their types. */
function liveFields(event: string, d: Record<string, unknown>): boolean {
  if (event === "record") {
    const r = d.record as Record<string, unknown> | null
    return isCount(d.seq) && !!r && typeof r === "object" && r.seq === d.seq && isText(r.kind)
  }
  if (!isText(d.node) || !isCount(d.n)) return false
  if (event === "call") return isText(d.text) && isCount(d.next_index)
  if (event === "start") return isTextOrNull(d.model) && isText(d.purpose) && isText(d.started_at)
  if (event === "chunk") return isCount(d.index) && isText(d.text)
  return isTextOrNull(d.error) // end
}

/**
 * Reads one live stream of a run from `path` (`/runs/{id}/live[?after=<seq>]`) over `target`, calling `handler` with
 * each frame and once with `run_end`, `reset` or `closed` at its end. Unknown events and malformed data are skipped.
 * It never reconnects: the caller decides when to open another.
 */
export function runLive(
  target: string | Transport,
  path: string,
  handler: (f: RunLiveFrame) => void,
  opts: { signal?: AbortSignal; token?: string } = {},
): { close(): void } {
  const t = transportOf(target)
  const abort = new AbortController()
  const signal = opts.signal ? AbortSignal.any([opts.signal, abort.signal]) : abort.signal
  let ended = false
  const end = (f: RunLiveFrame) => {
    // A stream the caller stopped reports nothing more.
    if (ended || opts.signal?.aborted) return
    ended = true
    abort.abort()
    handler(f)
  }
  const parser = createParser((m) => {
    if (ended) return
    if (m.event === "run_end" || m.event === "reset") return end({ type: m.event })
    if (m.event !== "record" && m.event !== "call" && m.event !== "start" && m.event !== "chunk" && m.event !== "end")
      return
    let data: unknown
    try {
      data = JSON.parse(m.data)
    } catch {
      return
    }
    const d = data as Record<string, unknown> | null
    if (!d || typeof d !== "object" || Array.isArray(d) || !liveFields(m.event, d)) return
    handler({ ...d, type: m.event } as RunLiveFrame)
  })
  void (async () => {
    try {
      const res = await officeFetch(t, path, {
        signal,
        headers: { accept: "text/event-stream", ...authorization(opts.token) },
      })
      if (res.status === 401)
        return end({ type: "closed", error: new UnknownDevice("unauthenticated", t.baseUrl !== undefined) })
      if (!res.ok || !res.body) {
        const d = (await res.json().catch(() => null)) as Record<string, unknown> | null
        const code = typeof d?.error === "string" ? d.error : "bad_response"
        const message = typeof d?.message === "string" ? d.message : `GET ${path}: HTTP ${res.status}`
        return end({ type: "closed", error: new OfficeError(res.status, code, message) })
      }
      const reader = res.body.getReader()
      for (let r = await reader.read(); !r.done && !ended; r = await reader.read()) parser.feed(r.value)
      end({ type: "closed" })
    } catch (error) {
      end({ type: "closed", error })
    }
  })()
  return {
    close() {
      ended = true
      abort.abort()
    },
  }
}

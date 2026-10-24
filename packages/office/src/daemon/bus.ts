/** The office's in-process event bus: stored metadata events and live transcript events. */
import type { Event, LiveEvent } from "@opencorp/protocol"

/** What `Subscription.next` returns when nothing arrived before the timeout. */
export const PING: unique symbol = Symbol("PING")

/** One bus item: a stored metadata event or a live transcript event. */
export type Item = readonly ["meta", Event] | readonly ["live", LiveEvent]

/** One subscriber's queue of bus items, optionally for one session or some metadata event types. */
export class Subscription {
  /** The session this subscription takes events for, or null for every session. */
  readonly session: string | null
  /** The metadata event types this subscription takes, or null for every event; with types, live events are
   *  dropped too. */
  readonly types: ReadonlySet<string> | null
  readonly #remove: (sub: Subscription) => void
  // null marks the end: a waiting reader gets it after every item queued before it.
  readonly #queue: (Item | null)[] = []
  #done = false
  #dropped = false
  #reading = false
  #wake: (() => void) | null = null

  constructor(remove: (sub: Subscription) => void, session: string | null, types: ReadonlySet<string> | null) {
    this.#remove = remove
    this.session = session
    this.types = types
  }

  /** Whether the bus dropped this subscription for falling behind. */
  get dropped(): boolean {
    return this.#dropped
  }

  /** How many items wait in the queue. */
  get queued(): number {
    return this.#queue.length
  }

  /** Whether `item` is of this subscription's types and belongs to its session (always, without either). */
  matches(item: Item): boolean {
    // Filtered here, before the queue: a type nobody wants (part.delta) must not fill a subscriber's queue and get
    // it dropped.
    if (this.types !== null && (item[0] !== "meta" || !this.types.has(item[1].type))) return false
    if (this.session === null) return true
    if (item[0] === "live") return item[1].session_id === this.session
    return item[1].subject_id === this.session || item[1].data.session_id === this.session
  }

  /** The next item, `PING` after `timeoutMs` idle, or null once ended (and forever after). One reader at a time. */
  async next(timeoutMs: number): Promise<Item | typeof PING | null> {
    if (this.#reading) throw new Error("a subscription has one reader at a time")
    if (this.#done) return null
    this.#reading = true
    try {
      if (this.#queue.length === 0) {
        const woken = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            this.#wake = null
            resolve(false)
          }, timeoutMs)
          this.#wake = () => {
            clearTimeout(timer)
            this.#wake = null
            resolve(true)
          }
        })
        if (!woken) return PING
      }
      // Never empty here: a wake follows a push, and no other reader can take that item first.
      const item = this.#queue.shift()!
      if (item === null) this.#done = true
      return item
    } finally {
      this.#reading = false
    }
  }

  /** Stop receiving items. A waiting `next()` is not woken; it returns `PING` at its timeout. */
  close(): void {
    this.#done = true
    this.#remove(this)
  }

  /** End it: a waiting `next()` returns null, as when the bus closes. */
  end(): void {
    this.#remove(this)
    this.push(null)
  }

  /** Queue `item` (null ends the subscription) and wake a waiting reader. Called by the bus. */
  push(item: Item | null): void {
    this.#queue.push(item)
    // The reader takes from the queue when it runs, as asyncio's queue does: a burst published before then
    // stays queued and can overflow it.
    this.#wake?.()
  }

  /** Mark it dropped, discard its backlog and end it. Called by the bus. */
  drop(): void {
    // The backlog is discarded: a dropped client re-reads state with GETs anyway.
    this.#dropped = true
    this.#queue.length = 0
    this.push(null)
  }
}

/**
 * Fans office events out to subscribers.
 *
 * Everything runs on the office's one thread: a publish fans out synchronously, so every subscriber sees one order.
 * A subscriber whose backlog reaches `queueSize` is dropped: it is removed, its backlog is discarded, `dropped` is
 * set, and its next `next()` returns null (the client reconnects and re-bootstraps).
 */
export class Bus {
  /** How many items a subscriber may have waiting before it is dropped. */
  queueSize: number
  #subs: Subscription[] = []
  #closed = false

  constructor({ queueSize = 1000 }: { queueSize?: number } = {}) {
    this.queueSize = queueSize
  }

  /** How many subscriptions are live. */
  get subscriberCount(): number {
    return this.#subs.length
  }

  /** Publish a stored metadata event (a store listener; never blocks). */
  publishMeta(event: Event): void {
    this.#fanout(["meta", event])
  }

  /** Publish a live transcript event. */
  publishLive(event: LiveEvent): void {
    this.#fanout(["live", event])
  }

  /** A new subscription to every event, or to one session's, optionally only metadata events of `types`. */
  subscribe(session: string | null = null, { types }: { types?: Iterable<string> } = {}): Subscription {
    // A string is an iterable of its characters, which would match nothing.
    if (typeof types === "string") throw new TypeError("types must be a collection of event types, not one string")
    const sub = new Subscription((s) => this.#remove(s), session, types === undefined ? null : new Set(types))
    if (this.#closed) sub.push(null)
    else this.#subs.push(sub)
    return sub
  }

  /** End every subscription and drop later publishes. */
  close(): void {
    this.#closed = true
    for (const sub of this.#subs) sub.push(null)
    this.#subs = []
  }

  #fanout(item: Item): void {
    if (this.#closed) return
    for (const sub of [...this.#subs]) {
      if (!sub.matches(item)) continue
      if (sub.queued >= this.queueSize) {
        this.#remove(sub)
        sub.drop()
      } else {
        sub.push(item)
      }
    }
  }

  #remove(sub: Subscription): void {
    const at = this.#subs.indexOf(sub)
    if (at !== -1) this.#subs.splice(at, 1)
  }
}

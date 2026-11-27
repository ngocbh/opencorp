/**
 * The replays' host: reads each replay (`replay.ts`: a node view, a model call, a derived commit) on the viewer thread
 * (`view_thread.ts`), one at a time, so a replay that takes seconds never holds the daemon's event loop. An ask waits
 * a moment for its replay and says it's still loading when that isn't enough; the replay goes on, and the next ask
 * under the same key finds it. A queued replay no one has asked for within `abandonMs` (or whose only reader left) is
 * dropped when its turn comes. A result asked to be kept answers every later ask, up to KEPT_BYTES and KEPT_RESULTS;
 * any other result, and a failure, is delivered once. A replay that runs past `limitMs` is given up and its thread
 * stopped; a thread that stops fails the replay it was reading, and the next replay starts another.
 */
import { Worker } from "node:worker_threads"
import { threadEntry } from "../../platform.ts"
import { errorName } from "../worker/rpc.ts"
import type { Replayed, ReplayJob } from "./replay.ts"

export type { ReplayJob } from "./replay.ts"

/** How long one replay may take before it is given up, in milliseconds. */
export const REPLAY_MS = 120_000
/** How long an ask waits for its replay before it says it's still loading, in milliseconds. */
export const WAIT_MS = 2000
/** How long a queued replay waits for its reader to ask again before it is dropped, in milliseconds. */
export const ABANDON_MS = 15_000
/** The most bytes of results kept. */
export const KEPT_BYTES = 32 << 20
/** The most results kept. */
export const KEPT_RESULTS = 64
/** How long close waits for the thread to stop, in milliseconds. */
const CLOSE_MS = 3000

/** What an ask gives while its replay isn't done. */
export const LOADING: unique symbol = Symbol("loading")

/** A replay couldn't be read; the message names only why (an error's type, a stopped thread, the time it took). */
export class ReplayFailed extends Error {
  override name = "ReplayFailed"
}

/** What the host uses of a thread; node's `Worker` fits. */
export interface ReplayThread {
  postMessage(message: unknown): void
  on(event: "message", fn: (reply: unknown) => void): unknown
  on(event: "error", fn: (error: Error) => void): unknown
  on(event: "exit", fn: (code: number) => void): unknown
  terminate(): Promise<number> | unknown
  unref(): void
}

function startThread(): ReplayThread {
  return new Worker(threadEntry("runs_viewer"), { workerData: { views: true } })
}

/** One replay asked for under its key: queued, being read, or done with its outcome; the asks waiting on it, and when
 *  it was last asked for. */
type Entry = {
  key: string
  job: ReplayJob
  keep: boolean
  state: "queued" | "running" | "done"
  outcome?: { value: Replayed } | { error: ReplayFailed }
  bytes: number
  askedAt: number
  waiters: Set<() => void>
}

/** Reads replays on one thread, one at a time, and keeps the results asked to be kept; see the module's doc. */
export class Replays {
  readonly #start: () => ReplayThread
  readonly #limitMs: number
  readonly #abandonMs: number
  readonly #keptBytes: number
  readonly #keptResults: number
  readonly #now: () => number
  readonly #log: (line: string) => void
  readonly #entries = new Map<string, Entry>()
  readonly #queue: Entry[] = []
  #held = 0
  #done = 0
  #thread: ReplayThread | null = null
  #current: { id: number; entry: Entry; timer: ReturnType<typeof setTimeout> } | null = null
  #ids = 0
  #closed = false

  constructor(
    options: {
      start?: () => ReplayThread
      limitMs?: number
      abandonMs?: number
      keptBytes?: number
      keptResults?: number
      now?: () => number
      log?: (line: string) => void
    } = {},
  ) {
    this.#start = options.start ?? startThread
    this.#limitMs = options.limitMs ?? REPLAY_MS
    this.#abandonMs = options.abandonMs ?? ABANDON_MS
    this.#keptBytes = options.keptBytes ?? KEPT_BYTES
    this.#keptResults = options.keptResults ?? KEPT_RESULTS
    this.#now = options.now ?? Date.now
    this.#log = options.log ?? (() => {})
  }

  /**
   * The result of `job`, the replay under `key`: at once when done (kept or not yet delivered), else once it is read,
   * if that's within `waitMs`; LOADING otherwise, or once `signal` aborts. A result is kept under `key` when `keep`
   * (`job` must then never change its result). Rejects with ReplayFailed when the replay can't be read, or the host is
   * closed.
   */
  async ask<T extends Replayed>(
    key: string,
    job: ReplayJob,
    { keep, waitMs = WAIT_MS, signal }: { keep: boolean; waitMs?: number; signal?: AbortSignal },
  ): Promise<T | typeof LOADING> {
    if (this.#closed) throw new ReplayFailed("the viewer thread is closed")
    let entry = this.#entries.get(key)
    if (entry === undefined) {
      entry = { key, job, keep, state: "queued", bytes: 0, askedAt: 0, waiters: new Set() }
      this.#entries.set(key, entry)
      this.#queue.push(entry)
    }
    entry.askedAt = this.#now()
    this.#next()
    if (entry.state !== "done" && !signal?.aborted) await this.#wait(entry, waitMs, signal)
    if (entry.state !== "done") {
      // Its only reader left before its turn: no one will ask for it.
      if (signal?.aborted && entry.state === "queued" && entry.waiters.size === 0) entry.askedAt = -Infinity
      if (this.#closed) throw new ReplayFailed("the viewer thread is closed")
      return LOADING
    }
    return this.#deliver<T>(entry)
  }

  /** Fails what is asked for, and stops the thread, waiting at most CLOSE_MS; later asks fail. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    if (this.#current !== null) clearTimeout(this.#current.timer)
    this.#current = null
    const closed = new ReplayFailed("the viewer thread is closed")
    for (const entry of this.#entries.values()) {
      if (entry.state !== "done") this.#settle(entry, { error: closed })
    }
    this.#entries.clear()
    this.#queue.length = 0
    const thread = this.#thread
    this.#thread = null
    if (thread === null) return
    const stopped = Promise.resolve().then(() => thread.terminate()).then(() => true, () => true)
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), CLOSE_MS)))
    try {
      if (!(await Promise.race([stopped, late]))) this.#log("viewer thread stopped (close timed out)")
    } finally {
      clearTimeout(timer)
    }
  }

  /** Resolves once `entry` is done, `waitMs` passed or `signal` aborted. */
  #wait(entry: Entry, waitMs: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        entry.waiters.delete(done)
        signal?.removeEventListener("abort", done)
        resolve()
      }
      const timer = setTimeout(done, waitMs)
      entry.waiters.add(done)
      signal?.addEventListener("abort", done, { once: true })
    })
  }

  /** `entry`'s outcome for an ask: its value, or its failure thrown; dropped after, unless it is a kept value. */
  #deliver<T extends Replayed>(entry: Entry): T {
    const outcome = entry.outcome!
    if ("error" in outcome || !entry.keep) this.#forget(entry)
    else this.#touch(entry)
    if ("error" in outcome) throw outcome.error
    return outcome.value as T
  }

  /** Starts the next queued replay unless one is being read, dropping those no one asks for any more. */
  #next(): void {
    while (this.#current === null && !this.#closed && this.#queue.length > 0) {
      const entry = this.#queue.shift()!
      if (entry.waiters.size === 0 && this.#now() - entry.askedAt > this.#abandonMs) {
        this.#entries.delete(entry.key)
        continue
      }
      const id = ++this.#ids
      entry.state = "running"
      this.#current = { id, entry, timer: setTimeout(() => this.#giveUp(), this.#limitMs) }
      try {
        this.#thread ??= this.#spawn()
        this.#thread.postMessage({ id, job: entry.job })
      } catch (error) {
        this.#finish({ error: new ReplayFailed(errorName(error)) })
      }
    }
  }

  #spawn(): ReplayThread {
    const thread = this.#start()
    // The thread never holds the daemon open; close ends it.
    thread.unref()
    // Each listener acts only while its thread is the current one: a stopped thread's late events touch nothing.
    thread.on("message", (reply) => {
      const { id, value, error } = (reply ?? {}) as { id?: unknown; value?: Replayed; error?: unknown }
      if (thread !== this.#thread || this.#current === null || id !== this.#current.id) return
      this.#finish(typeof error === "string" ? { error: new ReplayFailed(error) } : { value: value ?? null })
    })
    thread.on("error", (error) => {
      if (thread === this.#thread) this.#drop(errorName(error))
    })
    thread.on("exit", (code) => {
      if (thread === this.#thread) this.#drop(String(code))
    })
    return thread
  }

  /** The thread stopped: the replay it was reading fails. */
  #drop(why: string): void {
    this.#thread = null
    this.#log(`viewer thread stopped (${why})`)
    if (this.#current !== null) this.#finish({ error: new ReplayFailed(`the viewer thread stopped (${why})`) })
  }

  /** The replay being read took over `limitMs`: its thread is stopped, and the replay fails. */
  #giveUp(): void {
    const thread = this.#thread
    this.#thread = null
    if (thread !== null) void Promise.resolve().then(() => thread.terminate()).catch(() => {})
    this.#log(`a replay took over ${this.#limitMs / 1000} s; its thread was stopped`)
    this.#finish({ error: new ReplayFailed(`it took over ${this.#limitMs / 1000} s`) })
  }

  /** Settles the replay being read with `outcome`, and starts the next. */
  #finish(outcome: Entry["outcome"] & {}): void {
    const current = this.#current!
    clearTimeout(current.timer)
    this.#current = null
    this.#settle(current.entry, outcome)
    this.#next()
  }

  /** Marks `entry` done with `outcome`, wakes its waiters, and drops the least recently used past the caps. */
  #settle(entry: Entry, outcome: Entry["outcome"] & {}): void {
    entry.state = "done"
    entry.outcome = outcome
    if ("value" in outcome) {
      entry.bytes = Buffer.byteLength(JSON.stringify(outcome.value) ?? "")
      this.#held += entry.bytes
    }
    this.#done += 1
    // Moved to the end: the map's order is the done entries' use, oldest first.
    this.#entries.delete(entry.key)
    this.#entries.set(entry.key, entry)
    for (const wake of [...entry.waiters]) wake()
    this.#trim()
  }

  /** Marks `entry` the most recently used. */
  #touch(entry: Entry): void {
    this.#entries.delete(entry.key)
    this.#entries.set(entry.key, entry)
  }

  /** Drops done `entry`. */
  #forget(entry: Entry): void {
    if (this.#entries.get(entry.key) !== entry) return
    this.#entries.delete(entry.key)
    this.#held -= entry.bytes
    this.#done -= 1
  }

  /** Drops the least recently used done entries past KEPT_RESULTS or KEPT_BYTES. */
  #trim(): void {
    for (const entry of this.#entries.values()) {
      if (this.#done <= this.#keptResults && this.#held <= this.#keptBytes) return
      if (entry.state === "done") this.#forget(entry)
    }
  }
}

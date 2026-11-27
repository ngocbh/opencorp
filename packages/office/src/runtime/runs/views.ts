/**
 * The node views' host: reads each node view (`view.ts`) on the views thread (`view_thread.ts`), one at a time, so a
 * replay that takes seconds never holds the daemon's event loop. A queued view whose reader left is dropped; one being
 * read goes on, and a settled attempt's view is kept for the next reader, as it can't change. A view that runs past
 * `limitMs` is given up and its thread stopped; a thread that stops fails the view it was reading, and the next view
 * starts another.
 */
import { Worker } from "node:worker_threads"
import type { RunNodeView } from "@opencorp/protocol"
import { threadEntry } from "../../platform.ts"
import { errorName } from "../worker/rpc.ts"
import type { ViewJob } from "./view.ts"

export type { ViewJob } from "./view.ts"

/** How long one view may take before it is given up, in milliseconds. */
export const VIEW_MS = 120_000
/** The most bytes of views kept. */
export const KEPT_BYTES = 32 << 20
/** The most views kept. */
export const KEPT_VIEWS = 64
/** How long close waits for the thread to stop, in milliseconds. */
const CLOSE_MS = 3000

/** A view couldn't be read; the message names only why (an error's type, a stopped thread, the time it took). */
export class ViewFailed extends Error {
  override name = "ViewFailed"
}

/** What the host uses of a thread; node's `Worker` fits. */
export interface ViewThread {
  postMessage(message: unknown): void
  on(event: "message", fn: (reply: unknown) => void): unknown
  on(event: "error", fn: (error: Error) => void): unknown
  on(event: "exit", fn: (code: number) => void): unknown
  terminate(): Promise<number> | unknown
  unref(): void
}

function startThread(): ViewThread {
  return new Worker(threadEntry("runs_viewer"), { workerData: { views: true } })
}

/** A view asked for and not yet answered; `drop` stops listening to its reader's signal. */
type Asked = {
  job: ViewJob
  key: string | null
  resolve: (view: RunNodeView) => void
  reject: (error: unknown) => void
  drop: () => void
}

/** Reads node views on one thread, one at a time, and keeps the settled ones; see the module's doc. */
export class NodeViews {
  readonly #start: () => ViewThread
  readonly #limitMs: number
  readonly #keptBytes: number
  readonly #keptViews: number
  readonly #log: (line: string) => void
  readonly #queue: Asked[] = []
  readonly #kept = new Map<string, { view: RunNodeView; bytes: number }>()
  #held = 0
  #thread: ViewThread | null = null
  #current: { id: number; asked: Asked; timer: ReturnType<typeof setTimeout> } | null = null
  #ids = 0
  #closed = false

  constructor(
    options: {
      start?: () => ViewThread
      limitMs?: number
      keptBytes?: number
      keptViews?: number
      log?: (line: string) => void
    } = {},
  ) {
    this.#start = options.start ?? startThread
    this.#limitMs = options.limitMs ?? VIEW_MS
    this.#keptBytes = options.keptBytes ?? KEPT_BYTES
    this.#keptViews = options.keptViews ?? KEPT_VIEWS
    this.#log = options.log ?? (() => {})
  }

  /**
   * `job`'s view: kept under `key` once read (null: never kept, for an attempt that can still change), answered from
   * there when kept. Rejects with `signal`'s reason once it aborts, the view then dropped if it is still queued;
   * ViewFailed when it can't be read.
   */
  view(job: ViewJob, { key = null, signal }: { key?: string | null; signal?: AbortSignal } = {}): Promise<RunNodeView> {
    if (this.#closed) return Promise.reject(new ViewFailed("the views thread is closed"))
    const kept = key === null ? undefined : this.#take(key)
    if (kept !== undefined) return Promise.resolve(kept)
    if (signal?.aborted) return Promise.reject(signal.reason)
    return new Promise((resolve, reject) => {
      const asked: Asked = { job, key, resolve, reject, drop: () => {} }
      if (signal !== undefined) {
        const left = () => {
          const at = this.#queue.indexOf(asked)
          if (at !== -1) this.#queue.splice(at, 1)
          reject(signal.reason)
        }
        signal.addEventListener("abort", left, { once: true })
        asked.drop = () => signal.removeEventListener("abort", left)
      }
      this.#queue.push(asked)
      this.#next()
    })
  }

  /** Fails what is queued and being read, and stops the thread, waiting at most CLOSE_MS; later views fail. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const closed = new ViewFailed("the views thread is closed")
    if (this.#current !== null) this.#finish(closed)
    for (const asked of this.#queue.splice(0)) this.#settle(asked, closed)
    const thread = this.#thread
    this.#thread = null
    if (thread === null) return
    const stopped = Promise.resolve().then(() => thread.terminate()).then(() => true, () => true)
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), CLOSE_MS)))
    try {
      if (!(await Promise.race([stopped, late]))) this.#log("node views thread stopped (close timed out)")
    } finally {
      clearTimeout(timer)
    }
  }

  /** Starts the next queued view, answering those already kept, unless one is being read. */
  #next(): void {
    while (this.#current === null && !this.#closed && this.#queue.length > 0) {
      const asked = this.#queue.shift()!
      const kept = asked.key === null ? undefined : this.#take(asked.key)
      if (kept !== undefined) {
        this.#settle(asked, kept)
        continue
      }
      const id = ++this.#ids
      this.#current = { id, asked, timer: setTimeout(() => this.#giveUp(), this.#limitMs) }
      try {
        this.#thread ??= this.#spawn()
        this.#thread.postMessage({ id, job: asked.job })
      } catch (error) {
        this.#finish(new ViewFailed(errorName(error)))
      }
    }
  }

  #spawn(): ViewThread {
    const thread = this.#start()
    // The thread never holds the daemon open; close ends it.
    thread.unref()
    // Each listener acts only while its thread is the current one: a stopped thread's late events touch nothing.
    thread.on("message", (reply) => {
      const { id, view, error } = (reply ?? {}) as { id?: unknown; view?: RunNodeView; error?: unknown }
      if (thread !== this.#thread || this.#current === null || id !== this.#current.id) return
      this.#finish(typeof error === "string" ? new ViewFailed(error) : view!)
    })
    thread.on("error", (error) => {
      if (thread === this.#thread) this.#drop(errorName(error))
    })
    thread.on("exit", (code) => {
      if (thread === this.#thread) this.#drop(String(code))
    })
    return thread
  }

  /** The thread stopped: the view it was reading fails. */
  #drop(why: string): void {
    this.#thread = null
    this.#log(`node views thread stopped (${why})`)
    if (this.#current !== null) this.#finish(new ViewFailed(`the views thread stopped (${why})`))
  }

  /** The view being read took over `limitMs`: its thread is stopped, and the view fails. */
  #giveUp(): void {
    const thread = this.#thread
    this.#thread = null
    if (thread !== null) void Promise.resolve().then(() => thread.terminate()).catch(() => {})
    this.#log(`a node view took over ${this.#limitMs / 1000} s; its thread was stopped`)
    this.#finish(new ViewFailed(`it took over ${this.#limitMs / 1000} s`))
  }

  /** Answers the view being read with `result`, keeps it when it can, and starts the next. */
  #finish(result: RunNodeView | ViewFailed): void {
    const current = this.#current!
    clearTimeout(current.timer)
    this.#current = null
    if (!(result instanceof ViewFailed) && current.asked.key !== null) this.#keep(current.asked.key, result)
    this.#settle(current.asked, result)
    this.#next()
  }

  /** Answers `asked`; a reader that left was answered already, so this does nothing to it. */
  #settle(asked: Asked, result: RunNodeView | ViewFailed): void {
    asked.drop()
    if (result instanceof ViewFailed) asked.reject(result)
    else asked.resolve(result)
  }

  /** The view kept under `key`, now the most recently used; undefined when none is. */
  #take(key: string): RunNodeView | undefined {
    const kept = this.#kept.get(key)
    if (kept === undefined) return undefined
    this.#kept.delete(key)
    this.#kept.set(key, kept)
    return kept.view
  }

  /** Keeps `view` under `key`, dropping the least recently used past KEPT_VIEWS or KEPT_BYTES. */
  #keep(key: string, view: RunNodeView): void {
    const bytes = Buffer.byteLength(JSON.stringify(view))
    if (bytes > this.#keptBytes) return
    const old = this.#kept.get(key)
    if (old !== undefined) this.#held -= old.bytes
    this.#kept.delete(key)
    this.#kept.set(key, { view, bytes })
    this.#held += bytes
    while (this.#kept.size > this.#keptViews || this.#held > this.#keptBytes) {
      const [oldest, { bytes: dropped }] = this.#kept.entries().next().value!
      this.#kept.delete(oldest)
      this.#held -= dropped
    }
  }
}

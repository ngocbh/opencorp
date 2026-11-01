/** Keeps yian's run index up to date from the daemon: updates run one at a time on the index thread
 *  (`index_thread.ts`), and calls made while one runs share the next. */
import { Worker } from "node:worker_threads"
import { threadEntry } from "../platform.ts"
import { errorName } from "../worker/rpc.ts"

/** How long an update waits for the index's lock, in milliseconds. */
export const INDEX_TIMEOUT_MS = 2000

/** How long close waits for the thread to stop, in milliseconds: longer than INDEX_TIMEOUT_MS, as a healthy thread can
 *  be in SQLite's busy wait for the lock. */
export const CLOSE_MS = 3000

// The skipped logs already logged; cleared when full, so a damaged log is logged again only after many others.
const SKIPPED_CAP = 10_000

/** What the indexer uses of a thread; node's `Worker` fits. */
export interface IndexThread {
  postMessage(message: "update"): void
  on(event: "message", fn: (reply: unknown) => void): unknown
  on(event: "error", fn: (error: Error) => void): unknown
  on(event: "exit", fn: (code: number) => void): unknown
  terminate(): Promise<number> | unknown
  unref(): void
}

type Update = { promise: Promise<boolean>; resolve: (ok: boolean) => void }

function newUpdate(): Update {
  let resolve!: (ok: boolean) => void
  const promise = new Promise<boolean>((r) => (resolve = r))
  return { promise, resolve }
}

function startThread(runsDir: string, timeoutMs: number): IndexThread {
  return new Worker(threadEntry("runs_indexer"), { workerData: { runsDir, timeoutMs } })
}

/** Runs `updateRunIndex` over one runs folder on one thread; never rejects. */
export class RunIndexer {
  readonly #runsDir: string
  readonly #log: (line: string) => void
  readonly #start: (runsDir: string, timeoutMs: number) => IndexThread
  readonly #timeoutMs: number
  readonly #closeMs: number
  #thread: IndexThread | null = null
  #current: Update | null = null
  #next: Update | null = null
  #closed = false
  readonly #skipped = new Set<string>()

  constructor(
    runsDir: string,
    options: {
      log?: (line: string) => void
      start?: (runsDir: string, timeoutMs: number) => IndexThread
      timeoutMs?: number
      closeMs?: number
    } = {},
  ) {
    this.#runsDir = runsDir
    this.#log = options.log ?? (() => {})
    this.#start = options.start ?? startThread
    this.#timeoutMs = options.timeoutMs ?? INDEX_TIMEOUT_MS
    this.#closeMs = options.closeMs ?? CLOSE_MS
  }

  /** Brings the index up to date with an update that starts after this call: `true` when it did, `false` when it
   *  failed or the indexer is closed. */
  update(): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false)
    if (this.#current) {
      this.#next ??= newUpdate()
      return this.#next.promise
    }
    return this.#begin(newUpdate())
  }

  /** Ends the thread, waiting at most `closeMs` for it to stop; pending and later updates resolve `false`. A thread
   *  stuck in a system call (an open of a FIFO) outlives `terminate()`, so close then logs that it timed out and
   *  returns: the daemon's entry exits with `process.exit`, which doesn't wait for the thread. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const thread = this.#thread
    this.#thread = null
    this.#current?.resolve(false)
    this.#next?.resolve(false)
    this.#current = this.#next = null
    if (!thread) return
    // No new thread replaces a stuck one: it would only wait on the lock the stuck thread holds.
    const stopped = Promise.resolve()
      .then(() => thread.terminate())
      .then(() => true, () => true)
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), this.#closeMs)))
    try {
      if (!(await Promise.race([stopped, late]))) this.#log("run index thread stopped (close timed out)")
    } finally {
      clearTimeout(timer)
    }
  }

  #begin(update: Update): Promise<boolean> {
    this.#current = update
    try {
      this.#thread ??= this.#spawn()
      this.#thread.postMessage("update")
    } catch (error) {
      this.#log(`run index update failed (${errorName(error)})`)
      this.#settle(false)
    }
    return update.promise
  }

  /** Settles the update in flight and posts the queued one, if any. */
  #settle(ok: boolean): void {
    const done = this.#current
    const next = this.#next
    this.#current = this.#next = null
    done?.resolve(ok)
    if (next) this.#begin(next)
  }

  #spawn(): IndexThread {
    const thread = this.#start(this.#runsDir, this.#timeoutMs)
    // The thread never holds the daemon open; close ends it.
    thread.unref()
    // Each listener acts only while its thread is the current one: a dying thread emits error then exit, and the
    // late exit must not touch a newer thread or its update.
    thread.on("message", (reply) => {
      if (thread === this.#thread && this.#current) this.#reply(reply)
    })
    thread.on("error", (error) => {
      if (thread === this.#thread) this.#drop(errorName(error))
    })
    thread.on("exit", (code) => {
      if (thread === this.#thread) this.#drop(String(code))
    })
    return thread
  }

  #reply(reply: unknown): void {
    const { ok, error, skipped, rebuilt } = (reply ?? {}) as {
      ok?: unknown
      error?: unknown
      skipped?: unknown
      rebuilt?: unknown
    }
    if (typeof rebuilt === "string") this.#log(`run index damaged (${rebuilt}), rebuilding it`)
    if (Array.isArray(skipped)) {
      for (const path of skipped) {
        if (typeof path !== "string" || this.#skipped.has(path)) continue
        if (this.#skipped.size >= SKIPPED_CAP) this.#skipped.clear()
        this.#skipped.add(path)
        this.#log(`run index skipped ${path}`)
      }
    }
    if (ok !== true) this.#log(`run index update failed (${typeof error === "string" ? error : "Error"})`)
    this.#settle(ok === true)
  }

  #drop(why: string): void {
    this.#thread = null
    this.#log(`run index thread stopped (${why})`)
    if (this.#current) this.#settle(false)
  }
}

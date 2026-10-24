/** Polls the company clone's HEAD and records `company.updated` when it moves. */
import type { Office } from "../daemon/office.ts"

/** Records `company.updated` (`subject_id` and `data.sha`: the new HEAD) each time the clone's HEAD moves.
 *  It polls, as Argo CD and Flux poll git, so the office's own commits and an outside commit both count.
 *  The first read only sets the baseline. `start` and `stop` go in the office's `onStart` and `onStop`. */
export class HeadWatcher {
  readonly #office: Office
  readonly #intervalMs: number
  readonly #log: (message: string) => void
  #timer: ReturnType<typeof setInterval> | undefined
  #controller: AbortController | undefined
  #polling: Promise<void> | undefined
  #baseline = true
  #last: string | null = null

  constructor(
    office: Office,
    {
      intervalMs = 2000,
      log = console.error,
    }: {
      intervalMs?: number
      /** Gets raw log messages; the daemon wraps them with `logLine`. */
      log?: (message: string) => void
    } = {},
  ) {
    this.#office = office
    this.#intervalMs = intervalMs
    this.#log = log
  }

  /** Starts polling: one read now (the baseline), then one every `intervalMs`. */
  start(): void {
    if (this.#controller) return
    const controller = new AbortController()
    this.#controller = controller
    this.#baseline = true
    this.#last = null
    const tick = () => {
      // No overlapping polls, so `last` stays consistent.
      if (this.#polling) return
      const poll = this.#poll(controller.signal).finally(() => {
        if (this.#polling === poll) this.#polling = undefined
      })
      this.#polling = poll
    }
    tick()
    // A watcher someone forgot to stop must not keep the process alive; the daemon's server does that.
    this.#timer = setInterval(tick, this.#intervalMs)
    this.#timer.unref()
  }

  /** Stops polling and waits for a poll in progress; harmless if it never started. Nothing is recorded
   *  after it resolves. */
  async stop(): Promise<void> {
    if (!this.#controller) return
    clearInterval(this.#timer)
    this.#controller.abort()
    const poll = this.#polling
    this.#timer = undefined
    this.#controller = undefined
    this.#polling = undefined
    await poll
  }

  async #poll(signal: AbortSignal): Promise<void> {
    // Any failure (git missing, out of file descriptors, a locked store) is logged and the next poll tries
    // again: a watcher that died would stop company.updated until the office restarts.
    try {
      let sha: string | null
      try {
        sha = await this.#office.git.readHead()
      } catch (error) {
        if (!(error instanceof RangeError)) throw error
        sha = null // no commit yet
      }
      // Right after the only await, and emit is synchronous: nothing is recorded once stop has begun.
      if (signal.aborted) return
      if (this.#baseline) {
        // A commit made while the office starts can become the baseline and go unannounced; that's fine,
        // since clients read the company with a GET when they connect.
        this.#baseline = false
        this.#last = sha
      } else if (sha !== null && sha !== this.#last) {
        // As profile.updated does for other metadata kept outside the store.
        this.#office.store.emit("company.updated", sha, { sha })
        this.#last = sha // only once recorded, so a failed emit is retried
      }
    } catch (error) {
      // The type only: a git error can quote paths or output.
      const type = error instanceof Error ? error.constructor.name : typeof error
      try {
        this.#log(`couldn't check the company clone's HEAD or record company.updated: ${type}`)
      } catch {}
    }
  }
}

/** run.updated for what the store doesn't see (a run's open nodes): the first change at once, then at most one a
 *  second per run, the last change always sent. These go straight to the bus: its stream has no replay, and an outbox
 *  row per node would be too many writes; coalescing keeps a busy run from getting HQ's subscribers dropped. */
import { realScheduler, type Scheduler } from "@ngocbh/yian/platform"
import { Event, now, RunUpdated } from "@opencorp/protocol"
import { newId } from "../store/store.ts"
import { errorName } from "../worker/rpc.ts"

/** The least time between two run.updated of one run, in ms. */
export const EVERY_MS = 1000
/** How many sends at once go between prunes of long-quiet runs, so runs that never coalesce are forgotten too. */
export const PRUNE_EVERY = 256

/** A run.updated event, shaped as the outbox writes one. */
export function runUpdated(
  runId: string,
  sessionId: string,
  parentRunId: string | null,
  status: RunUpdated["status"],
  currentNodes: string[],
): Event {
  const data = RunUpdated.parse({
    run_id: runId,
    session_id: sessionId,
    parent_run_id: parentRunId,
    status,
    current_nodes: currentNodes,
  })
  return { id: newId(), type: "run.updated", at: now(), subject_id: runId, data }
}

/** Builds a run's run.updated when it is sent; null: nothing to send. */
export type BuildEvent = () => Event | null

/** Sends run changes through `publish` (the bus's `publishMeta`), coalesced per run to one each `every` ms. One timer
 *  sends the trailing events; `close` stops it. */
export class RunNotifier {
  readonly #publish: (event: Event) => void
  readonly #every: number
  readonly #scheduler: Scheduler
  readonly #log: (line: string) => void
  /** Run id to when its last event went. */
  readonly #sent = new Map<string, number>()
  /** Run id to how to build its next event. */
  readonly #pending = new Map<string, BuildEvent>()
  #timer: { at: number; abort: AbortController } | null = null
  #closed = false
  /** Sends at once since the last prune. */
  #atOnce = 0

  /** `every`: ms between a run's events (default `EVERY_MS`); `scheduler`: the clock and the timer's sleeps (default
   *  `realScheduler`); `log`: where a failed send is told (default `console.error`). */
  constructor(
    publish: (event: Event) => void,
    {
      every = EVERY_MS,
      scheduler = realScheduler,
      log = (line) => console.error(line),
    }: { every?: number; scheduler?: Scheduler; log?: (line: string) => void } = {},
  ) {
    this.#publish = publish
    this.#every = every
    this.#scheduler = scheduler
    this.#log = log
  }

  /** The runs whose last send is remembered, with when it went (read by tests). */
  get remembered(): ReadonlyMap<string, number> {
    return this.#sent
  }

  /** Run `runId` changed; `build()` makes its run.updated when it is sent. The first change in a while is built and
   *  published at once, on the caller's turn; later ones within `every` are coalesced, and the timer sends the last. */
  changed(runId: string, build: BuildEvent): void {
    if (this.#closed) return
    const at = this.#scheduler.now()
    if (!this.#pending.has(runId) && at - (this.#sent.get(runId) ?? -Infinity) >= this.#every) {
      this.#sent.set(runId, at)
      if (++this.#atOnce >= PRUNE_EVERY) this.#prune(at)
      this.#send(build)
      return
    }
    const fresh = !this.#pending.has(runId)
    this.#pending.set(runId, build)
    if (fresh) this.#arm()
  }

  /** Stops the timer; changes still waiting are dropped (clients refetch when they reconnect). */
  close(): void {
    this.#closed = true
    this.#pending.clear()
    this.#timer?.abort.abort()
    this.#timer = null
  }

  /** Arms the timer for the earliest pending run, unless it is already armed for then or sooner. */
  #arm(): void {
    let at = Infinity
    for (const runId of this.#pending.keys()) at = Math.min(at, (this.#sent.get(runId) ?? -Infinity) + this.#every)
    if (at === Infinity || (this.#timer !== null && this.#timer.at <= at)) return
    this.#timer?.abort.abort()
    const timer = { at, abort: new AbortController() }
    this.#timer = timer
    this.#scheduler.sleep(Math.max(0, at - this.#scheduler.now()), timer.abort.signal).then(
      () => {
        if (this.#timer !== timer) return
        this.#timer = null
        this.#flush()
        this.#arm()
      },
      // Aborted: `close`, or a sooner run re-armed the timer.
      () => {},
    )
  }

  /** Sends every pending run that is due. */
  #flush(): void {
    const at = this.#scheduler.now()
    const due: BuildEvent[] = []
    for (const [runId, build] of this.#pending) {
      if (at - (this.#sent.get(runId) ?? -Infinity) < this.#every) continue
      this.#sent.set(runId, at)
      this.#pending.delete(runId)
      due.push(build)
    }
    if (due.length > 0) this.#prune(at)
    for (const build of due) this.#send(build)
  }

  /** Forgets runs long quiet, so the map stays small. */
  #prune(at: number): void {
    this.#atOnce = 0
    for (const [runId, sent] of this.#sent) {
      if (at - sent > 10 * this.#every && !this.#pending.has(runId)) this.#sent.delete(runId)
    }
  }

  #send(build: BuildEvent): void {
    try {
      const event = build()
      if (event !== null) this.#publish(event)
    } catch (error) {
      // The type only: the error's message could quote a value.
      this.#log(`couldn't send a run.updated (${errorName(error)})`)
    }
  }
}

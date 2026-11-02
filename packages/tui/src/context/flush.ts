import { runEach } from "@opencorp/client"

/**
 * Batches changes to `S`: `mutate` queues a change, and every `ms` the queued ones go to `apply`
 * together. `later` runs a callback once the changes queued before it are applied, `settled`
 * resolves then, and `dispose` drops whatever is queued.
 */
export function createFlush<S>(apply: (fns: ((s: S) => void)[]) => void, ms: number) {
  let queue: ((s: S) => void)[] = []
  let after: (() => void)[] = []
  let waiters: (() => void)[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  function flush() {
    timer = undefined
    const fns = queue
    const calls = after
    const done = waiters
    queue = []
    after = []
    waiters = []
    apply(fns)
    // One bad callback mustn't drop the rest, or the callers waiting on them.
    runEach(calls)
    runEach(done)
  }

  return {
    mutate(fn: (s: S) => void) {
      if (disposed) return
      queue.push(fn)
      timer ??= setTimeout(flush, ms)
    },
    /** Runs `fn` once the changes queued so far are applied: at once if none are, never after `dispose`. */
    later(fn: () => void) {
      if (disposed) return
      if (!timer) return fn()
      after.push(fn)
    },
    /** Resolves once the changes queued so far are applied, or at once after `dispose`. */
    settled() {
      if (!timer || disposed) return Promise.resolve()
      return new Promise<void>((resolve) => waiters.push(resolve))
    },
    /** Drops the queued changes and callbacks; callers waiting in `settled` go on, since nothing will flush. */
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = undefined
      queue = []
      after = []
      runEach(waiters)
      waiters = []
    },
  }
}

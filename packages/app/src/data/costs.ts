type Clock = { now(): number; later(fn: () => void, ms: number): void }

const realClock: Clock = { now: () => Date.now(), later: (fn, ms) => void setTimeout(fn, ms) }

/**
 * Runs `fn` at most once every `ms`: a call inside the window schedules one run at its end, and further calls join
 * that run. `ran()` records a run made elsewhere (a snapshot read the costs), so the window starts then.
 */
export function throttle(fn: () => void, ms: number, clock: Clock = realClock) {
  let last = -Infinity
  let pending = false
  const run = () => {
    pending = false
    last = clock.now()
    fn()
  }
  return {
    call() {
      if (pending) return
      const wait = last + ms - clock.now()
      if (wait <= 0) return run()
      pending = true
      clock.later(run, wait)
    },
    ran() {
      last = clock.now()
    },
  }
}

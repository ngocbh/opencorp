import { expect, test } from "bun:test"
import { throttle } from "../src/data/costs"

/** A clock whose timers run only when the test says so. */
function fakeClock() {
  const c = { t: 0, due: [] as [number, () => void][] }
  return {
    c,
    clock: { now: () => c.t, later: (f: () => void, ms: number) => void c.due.push([c.t + ms, f]) },
    /** Moves to `t` and runs the timers due by then. */
    to(t: number) {
      c.t = t
      for (const [at, f] of c.due.splice(0).sort((a, b) => a[0] - b[0])) at <= t ? f() : c.due.push([at, f])
    },
  }
}

test("the first call runs now; calls inside the window share one run at its end", () => {
  const { c, clock, to } = fakeClock()
  const runs: number[] = []
  const th = throttle(() => runs.push(c.t), 10_000, clock)
  th.call()
  to(1_000)
  th.call()
  to(2_000)
  th.call()
  expect(runs).toEqual([0])
  to(10_000)
  expect(runs).toEqual([0, 10_000])
  to(25_000)
  th.call()
  expect(runs).toEqual([0, 10_000, 25_000])
})

test("ran() starts the window without running: a snapshot just read the costs", () => {
  const { c, clock, to } = fakeClock()
  const runs: number[] = []
  const th = throttle(() => runs.push(c.t), 10_000, clock)
  th.ran()
  to(4_000)
  th.call()
  expect(runs).toEqual([])
  to(10_000)
  expect(runs).toEqual([10_000])
})

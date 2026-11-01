/** Calls each of `fns` with `args`; one that throws is logged and skipped, so the rest still run. */
export function runEach<A extends unknown[]>(fns: Iterable<(...args: A) => unknown>, ...args: A) {
  for (const fn of fns) {
    try {
      fn(...args)
    } catch (error) {
      console.error("Failed to apply an office update", { error })
    }
  }
}

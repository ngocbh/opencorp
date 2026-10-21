/**
 * A queue that runs reads one at a time, in order. A read queued with a `key` is dropped while another with that key
 * is still waiting to start: the waiting one reads everything the dropped one would, so slow reads can't pile up.
 * A read's failure is its own to show; the queue goes on to the next.
 */
export function readQueue() {
  let tail: Promise<void> = Promise.resolve()
  const waiting = new Set<string>()
  return (read: () => Promise<void>, key?: string) => {
    if (key !== undefined) {
      if (waiting.has(key)) return
      waiting.add(key)
    }
    tail = tail
      .then(() => {
        if (key !== undefined) waiting.delete(key)
        return read()
      })
      .catch(() => undefined)
  }
}

/**
 * A limit on reads in flight: at most `n` run at once, and the rest start in the order they came as slots free up.
 * Each call answers with its read's answer or failure.
 */
export function readLimit(n: number) {
  let running = 0
  const waiting: (() => void)[] = []
  return async <T>(read: () => Promise<T>): Promise<T> => {
    if (running >= n) await new Promise<void>((start) => waiting.push(start))
    else running++
    try {
      return await read()
    } finally {
      // A freed slot passes straight to the next waiting read, so `running` stays counted.
      const next = waiting.shift()
      if (next) next()
      else running--
    }
  }
}

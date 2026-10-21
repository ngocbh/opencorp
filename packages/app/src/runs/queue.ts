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

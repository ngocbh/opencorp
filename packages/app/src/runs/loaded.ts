// A read the office answers by replaying the run log (a node's view, a model call, a derived record): it answers
// RunLoading while it still reads, at once, so the read asks again after the wait it names until the result comes.
import { isLoading } from "@opencorp/client"
import type { RunLoading } from "@opencorp/protocol"

/** Resolves after `ms`, or rejects with `signal`'s reason once it aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", left)
      resolve()
    }, ms)
    const left = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    signal?.addEventListener("abort", left, { once: true })
  })
}

/** `read`'s result, asked for again after each RunLoading's `retry_ms` (waited by `wait`) until it comes; rejects with
 *  `signal`'s reason once it aborts, and with `read`'s failure. */
export async function untilLoaded<T>(
  read: () => Promise<T | RunLoading>,
  signal?: AbortSignal,
  wait: (ms: number, signal?: AbortSignal) => Promise<void> = delay,
): Promise<T> {
  for (;;) {
    signal?.throwIfAborted()
    const reply = await read()
    signal?.throwIfAborted()
    if (!isLoading(reply)) return reply
    await wait(reply.retry_ms, signal)
  }
}

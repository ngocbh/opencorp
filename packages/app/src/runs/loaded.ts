// A read the office answers by replaying the run log (a node's view, a model call, a derived record): it answers
// RunLoading while it still reads, at once, so the read asks again, backing off, until the result comes or it has asked
// for too long.
import { isLoading } from "@opencorp/client"
import type { RunLoading } from "@opencorp/protocol"

/** The waits between asks, in milliseconds: the last one repeats. The office's `retry_ms` is the least. */
export const BACKOFF_MS: readonly number[] = [500, 1000, 2000, 4000]
/** How long a read goes on asking before it gives up, in milliseconds: past the office's own limit on a replay. */
export const LOADING_MS = 180_000

/** A read the office still hadn't finished after LOADING_MS of asking. */
export class StillLoading extends Error {
  override name = "StillLoading"

  constructor() {
    super("the office is still reading this from the log; try again in a while")
  }
}

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

/**
 * `read`'s result, asked for again while it answers RunLoading: after its `retry_ms` at least, backing off through
 * BACKOFF_MS. Rejects with StillLoading once LOADING_MS of asking passed, with `signal`'s reason once it aborts, and
 * with `read`'s failure. `wait` and `now` are for tests.
 */
export async function untilLoaded<T>(
  read: () => Promise<T | RunLoading>,
  signal?: AbortSignal,
  { wait = delay, now = Date.now }: { wait?: (ms: number, signal?: AbortSignal) => Promise<void>; now?: () => number } = {},
): Promise<T> {
  const started = now()
  for (let tries = 0; ; tries++) {
    signal?.throwIfAborted()
    const reply = await read()
    signal?.throwIfAborted()
    if (!isLoading(reply)) return reply
    if (now() - started >= LOADING_MS) throw new StillLoading()
    await wait(Math.max(reply.retry_ms, BACKOFF_MS[Math.min(tries, BACKOFF_MS.length - 1)]!), signal)
  }
}

/**
 * The views thread: it reads node views (`readView`, yian's `nodeView`) for the daemon, because a view replays the log
 * up to its attempt's end synchronously, which on a long run would hold the daemon's event loop for seconds. Each
 * request is `{id, job}`, and its reply `{id, view}` or `{id, error}`, the error only by its type's name: its message
 * may quote the log.
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads"
import { readView, type ViewJob } from "./view.ts"

// Local, as runtime/worker/rpc.ts's errorName would load yian's root, tools, zod and the protocol into this thread.
const NAME = /^[A-Za-z_$][\w$]{0,63}$/

/** A thrown value's name for a reply: an identifier-shaped `.name`, else "Error"; never throws. */
function errorName(error: unknown): string {
  try {
    if (!(error instanceof Error)) return typeof error
    const name: unknown = error.name
    return typeof name === "string" && NAME.test(name) ? name : "Error"
  } catch {
    return "Error"
  }
}

/** What `serve` listens and replies on; node's `MessagePort` and `parentPort` fit. */
export interface Port {
  on(event: "message", fn: (message: unknown) => void): unknown
  postMessage(reply: unknown): void
}

/** Answers each `{id, job}` on `port` with the job's view, or the name of the error reading it threw. */
export function serve(port: Port): void {
  port.on("message", async (message) => {
    const { id, job } = (message ?? {}) as { id?: unknown; job?: ViewJob }
    if (typeof id !== "number" || job === undefined) return
    try {
      port.postMessage({ id, view: await readView(job) })
    } catch (error) {
      port.postMessage({ id, error: errorName(error) })
    }
  })
}

if (!isMainThread && parentPort && workerData?.views) serve(parentPort)

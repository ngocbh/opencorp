/**
 * The run index's thread: it runs yian's `updateRunIndex` on the daemon's index thread, because the update is
 * synchronous and can wait on SQLite's lock for up to `timeoutMs`, which would block the daemon's event loop.
 * Only error type names and log paths leave the thread: a warning's message, which may quote a log's content,
 * stays here.
 */
import fs from "node:fs"
import { isMainThread, parentPort, workerData } from "node:worker_threads"
import { withWarnings } from "@ngocbh/yian/platform"
import { updateRunIndex } from "@ngocbh/yian/run"

// Lazy, so a message that itself holds "/log.jsonl: " can't stretch the path into it.
const SKIPPED = /^run index skipped (.+?\/log\.jsonl): /

// Local, as worker/rpc.ts's errorName would load yian's root, tools, zod and the protocol into this thread.
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

/** Answers each `"update"` on `port` with `{ ok: true, skipped }` once `runsDir`'s index is up to date (a missing
 *  `runsDir` is an empty index), or `{ ok: false, error, skipped }` with the error's type name; `skipped` lists
 *  the logs yian couldn't read. */
export function serve(port: Port, runsDir: string, timeoutMs: number): void {
  port.on("message", (message) => {
    if (message !== "update") return
    const skipped: string[] = []
    const collect = (warning: string) => {
      const match = SKIPPED.exec(warning)
      if (match) skipped.push(match[1]!)
    }
    let reply: { ok: true; skipped: string[] } | { ok: false; error: string; skipped: string[] }
    try {
      if (fs.existsSync(runsDir)) withWarnings(collect, () => updateRunIndex(runsDir, { timeoutMs }))
      reply = { ok: true, skipped }
    } catch (error) {
      reply = { ok: false, error: errorName(error), skipped }
    }
    port.postMessage(reply)
  })
}

if (!isMainThread && parentPort && workerData?.runsDir) serve(parentPort, workerData.runsDir, workerData.timeoutMs)

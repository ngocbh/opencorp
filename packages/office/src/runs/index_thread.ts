/**
 * The run index's thread: it runs yian's `updateRunIndex` on the daemon's index thread, because the update is
 * synchronous and can wait on SQLite's lock for up to `timeoutMs`, which would block the daemon's event loop.
 * Only error type names, SQLite code names and log paths leave the thread: a warning's message, which may quote a
 * log's content, stays here.
 */
import fs from "node:fs"
import path from "node:path"
import { isMainThread, parentPort, workerData } from "node:worker_threads"
import { sqliteErrorCode, withWarnings } from "@ngocbh/yian/platform"
import { updateRunIndex } from "@ngocbh/yian/run"

/** The SQLite primary codes of a damaged database file, by the name a reply gives them. */
const DAMAGED = new Map([
  [11, "SQLITE_CORRUPT"],
  [26, "SQLITE_NOTADB"],
])

/** The index's files under the runs folder: the database and what SQLite keeps beside it. */
const INDEX_FILES = ["index.sqlite", "index.sqlite-journal", "index.sqlite-wal", "index.sqlite-shm"]

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

/** The code name of the damage a SQLite `error` reports (`SQLITE_CORRUPT`, `SQLITE_NOTADB`), else null. */
function damage(error: unknown): string | null {
  const code = sqliteErrorCode(error)
  return code === undefined ? null : (DAMAGED.get(code & 0xff) ?? null)
}

/** Answers each `"update"` on `port` with `{ ok: true, skipped }` once `runsDir`'s index is up to date (a missing
 *  `runsDir` is an empty index), or `{ ok: false, error, skipped }` with the error's type name; `skipped` lists
 *  the logs yian couldn't read. An index SQLite reports damaged is removed and built again once from the logs, and
 *  the reply's `rebuilt` names the damage. */
export function serve(port: Port, runsDir: string, timeoutMs: number): void {
  port.on("message", (message) => {
    if (message !== "update") return
    const skipped: string[] = []
    const collect = (warning: string) => {
      const match = SKIPPED.exec(warning)
      if (match) skipped.push(match[1]!)
    }
    const update = () => withWarnings(collect, () => updateRunIndex(runsDir, { timeoutMs }))
    let rebuilt: string | null = null
    let reply: { ok: boolean; error?: string; skipped: string[]; rebuilt?: string }
    try {
      if (fs.existsSync(runsDir)) {
        try {
          update()
        } catch (error) {
          rebuilt = damage(error)
          if (rebuilt === null) throw error
          // The index is derived from the logs, so a damaged one is dropped rather than repaired. Only this thread
          // drops it: a read that finds it damaged falls back to the logs (records.ts) rather than race this rebuild.
          skipped.length = 0
          for (const name of INDEX_FILES) fs.rmSync(path.join(runsDir, name), { force: true })
          update()
        }
      }
      reply = { ok: true, skipped }
    } catch (error) {
      reply = { ok: false, error: errorName(error), skipped }
    }
    if (rebuilt !== null) reply.rebuilt = rebuilt
    port.postMessage(reply)
  })
}

if (!isMainThread && parentPort && workerData?.runsDir) serve(parentPort, workerData.runsDir, workerData.timeoutMs)

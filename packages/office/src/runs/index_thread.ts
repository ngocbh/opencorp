/**
 * The run index's thread: it runs yian's `updateRunIndex`, then `readRunIndex`, on the daemon's index thread, because
 * both are synchronous: the update can wait on SQLite's lock for up to `timeoutMs`, and the read probes the lock of
 * every unfinished run's log; either would block the daemon's event loop.
 * Only error type names, SQLite code names, log paths and the index's rows leave the thread: a warning's message,
 * which may quote a log's content, stays here.
 */
import fs from "node:fs"
import path from "node:path"
import { isMainThread, parentPort, workerData } from "node:worker_threads"
import { sqliteErrorCode, withWarnings } from "@ngocbh/yian/platform"
import { readRunIndex, type RunIndexRow, updateRunIndex } from "@ngocbh/yian/run"

/** SQLite's primary result codes, by number. */
const CODES = [
  "SQLITE_OK",
  "SQLITE_ERROR",
  "SQLITE_INTERNAL",
  "SQLITE_PERM",
  "SQLITE_ABORT",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_NOMEM",
  "SQLITE_READONLY",
  "SQLITE_INTERRUPT",
  "SQLITE_IOERR",
  "SQLITE_CORRUPT",
  "SQLITE_NOTFOUND",
  "SQLITE_FULL",
  "SQLITE_CANTOPEN",
  "SQLITE_PROTOCOL",
  "SQLITE_EMPTY",
  "SQLITE_SCHEMA",
  "SQLITE_TOOBIG",
  "SQLITE_CONSTRAINT",
  "SQLITE_MISMATCH",
  "SQLITE_MISUSE",
  "SQLITE_NOLFS",
  "SQLITE_AUTH",
  "SQLITE_FORMAT",
  "SQLITE_RANGE",
  "SQLITE_NOTADB",
  "SQLITE_NOTICE",
  "SQLITE_WARNING",
]

// The codes of an index a rebuild from the logs cures: ERROR is a table yian's fixed SQL doesn't fit (an index whose
// layout version is right but whose table isn't), PERM and READONLY a file this process can't write, CORRUPT and
// NOTADB a damaged file. BUSY (another builder holds the lock), FULL, IOERR, NOMEM and INTERRUPT aren't cured by
// dropping the index: its rows still work, and the rebuild would fail the same way.
const CURABLE = new Set([1, 3, 8, 11, 26])
const SQLITE_CANTOPEN = 14

/** How long after a rebuild that failed the next one may be tried, in milliseconds. */
export const REBUILD_RETRY_MS = 10 * 60_000

/** The index's files under the runs folder: the database and what SQLite keeps beside it. */
const INDEX_FILES = ["index.sqlite", "index.sqlite-journal", "index.sqlite-wal", "index.sqlite-shm"]

// Lazy, so a message that itself holds "/log.jsonl: " can't stretch the path into it.
const SKIPPED = /^run index skipped (.+?\/log\.jsonl): /
// The read names a row it skips by its run id.
const SKIPPED_ROW = /^run index skipped (.+?): /

// Local, as worker/rpc.ts's errorName would load yian's root, tools, zod and the protocol into this thread.
const NAME = /^[A-Za-z_$][\w$]{0,63}$/
const FS_CODE = /^E[A-Z0-9]{1,15}$/

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

/** A failure's name for a reply and the daemon's log: a SQLite error's code name (`SQLITE_IOERR`), an fs error's
 *  code (`EACCES`), else its type name (`RunIndexBusyError`); never SQLite's message, and never throws. */
function failureName(error: unknown): string {
  const code = sqliteErrorCode(error)
  if (code !== undefined) return CODES[code & 0xff] ?? `SQLITE_${code & 0xff}`
  try {
    const fsCode: unknown = (error as { code?: unknown } | null)?.code
    if (typeof fsCode === "string" && FS_CODE.test(fsCode)) return fsCode
  } catch {}
  return errorName(error)
}

/** The code name of an index failure a rebuild from the logs cures, else null. CANTOPEN is cured only for a regular
 *  file at the index's path: a folder or a link there is left alone. */
function curable(error: unknown, indexPath: string): string | null {
  const code = sqliteErrorCode(error)
  if (code === undefined) return null
  const primary = code & 0xff
  if (CURABLE.has(primary)) return failureName(error)
  if (primary !== SQLITE_CANTOPEN) return null
  try {
    return fs.lstatSync(indexPath, { throwIfNoEntry: false })?.isFile() ? failureName(error) : null
  } catch {
    return null
  }
}

/** True for a run id that names a folder directly under the runs folder. */
function safeRunId(runId: string): boolean {
  return runId !== "" && runId !== "." && runId !== ".." && !/[/\\\0]/.test(runId)
}

/** What `serve` listens and replies on; node's `MessagePort` and `parentPort` fit. */
export interface Port {
  on(event: "message", fn: (message: unknown) => void): unknown
  postMessage(reply: unknown): void
}

/** What `serve` replies to an update. */
export interface Reply {
  ok: boolean
  /** Why the update failed: a code or type name. */
  error?: string
  /** The logs yian couldn't read, by path. */
  skipped: string[]
  /** The code name of the failure the index was dropped and built again for. */
  rebuilt?: string
  /** The index's rows as the read after the update found them; `null` when the read failed. */
  rows: RunIndexRow[] | null
  /** Why the read failed: a code or type name. */
  readError?: string
}

/** Answers each `"update"` on `port` once `runsDir`'s index is brought up to date (a missing `runsDir` is an empty
 *  index) and read: `ok` says whether the update worked (`error` names why not), `rows` holds the rows the read
 *  after it found, whether or not it worked (`null`, with `readError`, when the read failed), and `skipped` lists
 *  the logs and rows yian couldn't read. An index whose failure a rebuild cures (`curable`) is removed and built
 *  again once from the logs, and the reply's `rebuilt` names the failure; after a rebuild that failed, none is tried
 *  for `REBUILD_RETRY_MS`. */
export function serve(
  port: Port,
  runsDir: string,
  timeoutMs: number,
  { now = Date.now }: { now?: () => number } = {},
): void {
  const indexPath = path.join(runsDir, INDEX_FILES[0]!)
  let rebuildFailedAt = -Infinity
  port.on("message", (message) => {
    if (message !== "update") return
    const skipped: string[] = []
    const collect = (warning: string) => {
      const match = SKIPPED.exec(warning)
      if (match) skipped.push(match[1]!)
    }
    const update = () => withWarnings(collect, () => updateRunIndex(runsDir, { timeoutMs }))
    let rebuilt: string | null = null
    let reply: Reply
    try {
      if (fs.existsSync(runsDir)) {
        try {
          update()
        } catch (error) {
          const name = curable(error, indexPath)
          if (name === null || now() - rebuildFailedAt < REBUILD_RETRY_MS) throw error
          rebuilt = name
          // The index is derived from the logs, so an unusable one is dropped rather than repaired. Only this thread
          // drops it, and never a folder (rmSync isn't recursive). One retry, so a rebuild that fails can't loop.
          try {
            skipped.length = 0
            for (const file of INDEX_FILES) fs.rmSync(path.join(runsDir, file), { force: true })
            update()
          } catch (retryError) {
            rebuildFailedAt = now()
            throw retryError
          }
          rebuildFailedAt = -Infinity
        }
      }
      reply = { ok: true, skipped, rows: null }
    } catch (error) {
      reply = { ok: false, error: failureName(error), skipped, rows: null }
    }
    if (rebuilt !== null) reply.rebuilt = rebuilt
    try {
      reply.rows = withWarnings(
        (warning) => {
          const match = SKIPPED_ROW.exec(warning)
          if (match && safeRunId(match[1]!)) skipped.push(path.join(runsDir, match[1]!, "log.jsonl"))
        },
        () => readRunIndex(runsDir, { timeoutMs }),
      )
    } catch (error) {
      reply.readError = failureName(error)
    }
    port.postMessage(reply)
  })
}

if (!isMainThread && parentPort && workerData?.runsDir) serve(parentPort, workerData.runsDir, workerData.timeoutMs)

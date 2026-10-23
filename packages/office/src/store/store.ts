/** The office's SQLite store: opening the database, 0600, in WAL mode, migrated. */
import fs from "node:fs"
import path from "node:path"
import { openSqlite, sqliteErrorCode, type Sqlite, type SqliteStatement } from "@ngocbh/yian/platform"
import { migrate } from "./migrate.ts"

/** How long a connection waits for another writer's lock, in ms. */
export const BUSY_TIMEOUT_MS = 10_000

/** A store operation was refused. */
export class StoreError extends Error {
  override name = "StoreError"
}

/** Puts the database in WAL mode, unless it already is. Switching needs an exclusive lock: when several
 *  processes open a new database at once, SQLite can report it busy without calling the busy handler, so
 *  this retries with backoff for up to `timeoutMs`. */
export function enableWal(
  db: { prepare(sql: string): Pick<SqliteStatement, "get"> },
  timeoutMs = BUSY_TIMEOUT_MS,
): void {
  const deadline = performance.now() + timeoutMs
  let delay = 5
  for (;;) {
    try {
      if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal") db.prepare("PRAGMA journal_mode = WAL").get()
      return
    } catch (error) {
      // The low byte is the primary result code (SQLITE_BUSY_RECOVERY is a BUSY too).
      const code = (sqliteErrorCode(error) ?? 0) & 0xff
      if ((code !== 5 && code !== 6) || performance.now() + delay > deadline) throw error
      // A synchronous sleep, as this runs once while the daemon starts, before it serves anything.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
      delay = Math.min(delay * 2, 250)
    }
  }
}

/** Options for opening a store. */
export interface StoreOptions {
  /** Where the store writes its log lines (default `console.error`). */
  log?: (line: string) => void
}

/** Creates the store file 0600 if it's missing; throws `StoreError` if the path is anything but a regular
 *  file (a symlink is never followed). */
function createStoreFile(file: string): void {
  const { O_CREAT, O_EXCL, O_NOFOLLOW, O_RDWR } = fs.constants
  try {
    fs.closeSync(fs.openSync(file, O_CREAT | O_EXCL | O_NOFOLLOW | O_RDWR, 0o600))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "EEXIST" && code !== "ELOOP") throw error
    if (!fs.lstatSync(file).isFile()) throw new StoreError(`store file ${file} is not a regular file`)
  }
}

/** The office store at `path`: created 0600 in a 0700 dir, WAL mode, migrated on open. */
export class Store {
  readonly path: string
  #db: Sqlite
  #closed = false

  constructor(file: string, _options?: StoreOptions) {
    this.path = file
    // Every file SQLite creates beside the store (-wal, -shm, journals) is private too.
    const old = process.umask(0o077)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      createStoreFile(file)
      const db = openSqlite(file)
      try {
        db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
        db.exec("PRAGMA foreign_keys = ON")
        db.exec("PRAGMA synchronous = NORMAL")
        enableWal(db)
        migrate(db)
      } catch (error) {
        db.close()
        throw error
      }
      this.#db = db
    } finally {
      process.umask(old)
    }
  }

  /** The connection; throws `StoreError("the store is closed")` after `close()`. */
  get db(): Sqlite {
    if (this.#closed) throw new StoreError("the store is closed")
    return this.#db
  }

  /** Closes the connection; a second call does nothing. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }
}

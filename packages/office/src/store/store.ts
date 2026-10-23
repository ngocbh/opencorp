/** The office's SQLite store: opening the database, 0600, in WAL mode, migrated; synchronous write
 *  transactions whose events reach listeners after the commit. */
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  openSqlite,
  sqliteErrorCode,
  type Sqlite,
  type SqliteParam,
  type SqliteRow,
  type SqliteStatement,
} from "@ngocbh/yian/platform"
import { Event, now, validationMessage } from "@opencorp/protocol"
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

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const RANDOM_LIMIT = 1n << 80n
let lastTime = -1
let lastRandom = 0n

/** `n` in Crockford base32, `length` chars, zero-padded. */
function base32(n: bigint, length: number): string {
  let out = ""
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[Number(n & 31n)] + out
    n >>= 5n
  }
  return out
}

/** A new ULID: 48-bit ms time + 80 random bits, Crockford base32, strictly increasing within this process.
 *  When the clock hasn't moved past the last id's time (same ms, or it went back), the id keeps the last
 *  time and takes the last random part plus one. */
export function newId(): string {
  const t = Date.now()
  if (t > lastTime) {
    lastTime = t
    lastRandom = BigInt(`0x${randomBytes(10).toString("hex")}`)
  } else if (++lastRandom === RANDOM_LIMIT) {
    lastTime += 1
    lastRandom = BigInt(`0x${randomBytes(10).toString("hex")}`)
  }
  return base32(BigInt(lastTime), 10) + base32(lastRandom, 16)
}

/** Whether `db` has a transaction open. */
function inTransaction(db: Sqlite): boolean {
  // Yian's Sqlite has no inTransaction. BEGIN fails only while a transaction is open, and when it
  // succeeds the ROLLBACK undoes the probe.
  try {
    db.exec("BEGIN")
  } catch {
    return true
  }
  db.exec("ROLLBACK")
  return false
}

/** Throws `StoreError` if `result` is a promise or other thenable: an awaiting callback would run its
 *  continuation after the transaction ended. */
function refuseAsync<T>(result: T): T {
  if (typeof (result as { then?: unknown } | null | undefined)?.then !== "function") return result
  // A thenable may lack catch, and its later rejection (the continuation's "transaction is over") must
  // not surface as an unhandled rejection.
  Promise.resolve(result).catch(() => {})
  throw new StoreError("a store transaction callback must not be async: never await inside transaction()")
}

/** One write transaction on the store's connection. */
export class Tx {
  readonly events: Event[] = []
  /** How many savepoints are open inside this transaction. */
  depth = 0
  /** Set once the outermost transaction ended. */
  over = false
  readonly #db: Sqlite

  constructor(db: Sqlite) {
    this.#db = db
  }

  /** Throws StoreError once this transaction can't take more statements: "the transaction is over" after
   *  its outermost transaction ended, or "SQLite rolled back this transaction after an error; start a new
   *  one" when SQLite has ended it (e.g. a full disk). */
  checkOpen(): void {
    if (this.over) throw new StoreError("the transaction is over")
    // Probed before every statement: a failed statement anywhere on the connection, even a read outside
    // this Tx, can end the transaction, and later statements would then each commit on their own.
    if (!inTransaction(this.#db)) {
      throw new StoreError("SQLite rolled back this transaction after an error; start a new one")
    }
  }

  /** Runs one statement in this transaction. */
  run(sql: string, ...params: SqliteParam[]): void {
    this.checkOpen()
    this.#db.prepare(sql).run(...params)
  }

  /** Reads one row in this transaction. */
  get(sql: string, ...params: SqliteParam[]): SqliteRow | undefined {
    this.checkOpen()
    return this.#db.prepare(sql).get(...params)
  }

  /** Validates and records an Event (new ULID, now()); listeners get it after the outermost commit. */
  emit(type: Event["type"], subjectId: string, data: Record<string, unknown>): Event {
    this.checkOpen()
    const input = { id: newId(), type, at: now(), subject_id: subjectId, data }
    const result = Event.safeParse(input)
    if (!result.success) throw new StoreError(`bad event: ${validationMessage(Event, result.error, input)}`)
    this.events.push(result.data)
    return result.data
  }
}

/** Called with each event after its transaction commits. */
export type Listener = (event: Event) => void

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
  #tx: Tx | undefined
  #listeners: Listener[] = []

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

  /** Runs `fn` in a write transaction (`BEGIN IMMEDIATE`) and returns its result. Store methods called inside
   *  join it; a nested `transaction()` is a savepoint: if it throws, only its own writes and events are undone.
   *  Events reach listeners after the outermost commit.
   *
   *  The callback must be synchronous: an async one is refused and rolled back, and its continuation's `tx.*`
   *  calls throw "the transaction is over" (a store method it calls later still opens its own transaction:
   *  only the refused `Tx` is dead). */
  transaction<T>(fn: (tx: Tx) => T): T {
    if (this.#tx) return this.#savepoint(this.#tx, fn)
    const db = this.db
    db.exec("BEGIN IMMEDIATE")
    const tx = new Tx(db)
    this.#tx = tx
    let result: T
    try {
      result = refuseAsync(fn(tx))
      tx.checkOpen()
      db.exec("COMMIT")
    } catch (error) {
      if (inTransaction(db)) db.exec("ROLLBACK")
      throw error
    } finally {
      this.#tx = undefined
      tx.over = true
    }
    this.#deliver(tx.events)
    return result
  }

  #savepoint<T>(tx: Tx, fn: (tx: Tx) => T): T {
    const db = this.db
    tx.checkOpen()
    const name = `sp${tx.depth + 1}`
    db.exec(`SAVEPOINT ${name}`)
    tx.depth += 1
    const mark = tx.events.length
    try {
      const result = refuseAsync(fn(tx))
      tx.checkOpen()
      db.exec(`RELEASE ${name}`)
      return result
    } catch (error) {
      // If the error made SQLite end the whole transaction, the savepoint is gone: keep the original error
      // rather than throwing "no such savepoint".
      if (inTransaction(db)) {
        db.exec(`ROLLBACK TO ${name}`)
        db.exec(`RELEASE ${name}`)
      }
      tx.events.length = mark
      throw error
    } finally {
      tx.depth -= 1
    }
  }

  /** Writes an event with no other change (for metadata kept outside the store). */
  emit(type: Event["type"], subjectId: string, data: Record<string, unknown>): Event {
    return this.transaction((tx) => tx.emit(type, subjectId, data))
  }

  /** Calls `listener(event)` for each event after its transaction commits; returns a function that removes
   *  it (a second call does nothing). */
  addListener(listener: Listener): () => void {
    this.#listeners.push(listener)
    let removed = false
    return () => {
      if (removed) return
      removed = true
      this.#listeners.splice(this.#listeners.indexOf(listener), 1)
    }
  }

  #deliver(events: Event[]): void {
    for (const event of events) for (const listener of [...this.#listeners]) listener(event)
  }

  /** Closes the connection; a second call does nothing. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }
}

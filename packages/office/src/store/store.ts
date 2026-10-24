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
import { CostReport, Event, Session, now, validationMessage } from "@opencorp/protocol"
import type { z } from "zod"
import { migrate } from "./migrate.ts"

/** How long a connection waits for another writer's lock, in ms. */
export const BUSY_TIMEOUT_MS = 10_000

/** A store operation was refused. */
export class StoreError extends Error {
  override name = "StoreError"
}

/** The row to change does not exist. */
export class NotFound extends StoreError {
  override name = "NotFound"
}

/** A row with the same key already exists. */
export class DuplicateKey extends StoreError {
  override name = "DuplicateKey"
}

/** A folder a person has had a session in, for the picker. */
export interface WorkedFolder {
  cwd: string
  lastAt: string
}

/** A stored session, defaults filled. */
export type SessionRecord = z.output<typeof Session>

/** The longest reason a run shows. */
export const REASON_CHARS = 200
/** The longest reason a run keeps. */
export const REASON_KEPT = 256

/** `reason` cut to `limit` characters, ending in "…" when cut. */
export function cutReason(reason: string, limit = REASON_CHARS): string {
  // A string has at least as many UTF-16 units as characters, so a short one needs no split.
  if (reason.length <= limit) return reason
  // By code point, so a cut never splits a surrogate pair.
  const chars = Array.from(reason)
  return chars.length <= limit ? reason : chars.slice(0, limit - 1).join("") + "…"
}

/** A run as the office keeps it: who drove it, what it ran, the connection, model and config hash that decide
 *  resume or a fresh run, the run it replaced, and the end the office decided (if any). */
export interface RunRow {
  runId: string
  sessionId: string
  driver: string
  flow: string
  flowPath: string
  connection: string | null
  model: string | null
  configSha256: string | null
  endReason: string | null
  endedAt: string | null
  replacesRunId: string | null
  createdAt: string
}

/** The run in a `runs` row. */
function runRow(r: SqliteRow): RunRow {
  return {
    runId: r.run_id as string,
    sessionId: r.session_id as string,
    driver: r.driver as string,
    flow: r.flow as string,
    flowPath: r.flow_path as string,
    connection: r.connection as string | null,
    model: r.model as string | null,
    configSha256: r.config_sha256 as string | null,
    endReason: r.end_reason as string | null,
    endedAt: r.ended_at as string | null,
    replacesRunId: r.replaces_run_id as string | null,
    createdAt: r.created_at as string,
  }
}

/** An entity table: its protocol schema and how its fields map to columns. */
interface Table<S extends z.ZodObject> {
  name: string
  label: string
  key: string
  schema: S
  /** Fields stored as JSON text. */
  json: Set<string>
  /** Fields stored as 0/1. */
  bools: Set<string>
  /** Fields kept in a child table rather than a column. */
  derived: Set<string>
}

const SESSIONS: Table<typeof Session> = {
  name: "sessions",
  label: "Session",
  key: "id",
  schema: Session,
  json: new Set(["harness_usage", "waiting_on"]),
  bools: new Set(["capped"]),
  derived: new Set(["run_ids"]),
}

/** `name` quoted as an SQL identifier (a column may be a keyword, like `groups`). */
function quote(name: string): string {
  return `"${name}"`
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
  // This probe stands in until Yian's Sqlite has an inTransaction (gap reported). BEGIN fails only while a
  // transaction is open, and when it succeeds the ROLLBACK undoes the probe.
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

  /** Inserts `cols` into `table`; a UNIQUE or PRIMARY KEY clash → DuplicateKey, a missing parent row (FOREIGN
   *  KEY) → NotFound("<table>: the row it belongs to does not exist"), any other constraint → StoreError. */
  insert(table: string, cols: Record<string, SqliteParam>): void {
    const names = Object.keys(cols)
    const sql = `INSERT INTO ${quote(table)} (${names.map(quote).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`
    try {
      this.run(sql, ...Object.values(cols))
    } catch (error) {
      // SQLite's constraint messages name columns, never values.
      const code = sqliteErrorCode(error)
      if (code === 2067 || code === 1555) throw new DuplicateKey(`${table}: ${(error as Error).message}`)
      if (code === 787) throw new NotFound(`${table}: the row it belongs to does not exist`)
      if (code !== undefined && (code & 0xff) === 19) throw new StoreError(`${table}: ${(error as Error).message}`)
      throw error
    }
  }

  /** Updates the row whose `key` column equals `cols[key]` with the other columns. */
  update(table: string, key: string, cols: Record<string, SqliteParam>): void {
    const names = Object.keys(cols).filter((name) => name !== key)
    this.run(
      `UPDATE ${quote(table)} SET ${names.map((name) => `${quote(name)} = ?`).join(", ")} WHERE ${quote(key)} = ?`,
      ...names.map((name) => cols[name] as SqliteParam),
      cols[key] as SqliteParam,
    )
  }

  /** Validates and records an Event (new ULID, now()); listeners get it after the outermost commit. */
  emit(type: Event["type"], subjectId: string, data: Record<string, unknown>): Event {
    this.checkOpen()
    // A copy, so a listener that keeps the event never sees the caller's later changes to its record.
    const input = { id: newId(), type, at: now(), subject_id: subjectId, data: structuredClone(data) }
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

/** One tool call as recorded by the permission layer. */
export interface AuditEntry {
  id: number
  at: string
  person: string
  kind: string
  tool: string
  args: Record<string, unknown>
  outcome: string
  sessionId: string | null
  runId: string | null
  detail: string | null
}

/** The price of one model call. */
export interface UsageRecord {
  id: number
  at: string
  sessionId: string
  runId: string
  model: string
  usd: number
}

/** A spawned process under its key, for the reaper. */
export interface WorkerRecord {
  key: string
  pid: number
  pgid: number
  startTime: number
}

/** Sets an existing store file to 0600 if it has any group or other bits; does nothing if it's missing;
 *  throws `StoreError` if it's anything but a regular file (a symlink is never followed). */
function tighten(file: string): void {
  // SQLite gives a new -wal or -shm the database's mode but never tightens an existing file, so a store
  // copied or restored with a loose mode would stay readable, and spread it to its sidecars.
  const { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } = fs.constants
  let fd: number
  try {
    // O_NONBLOCK: a FIFO would otherwise block the open until a writer appears.
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    // A symlink (ELOOP), a socket (EOPNOTSUPP, ENXIO on Linux) or anything else that isn't a regular file.
    if (!fs.lstatSync(file).isFile()) throw new StoreError(`store file ${file} is not a regular file`)
    throw error
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw new StoreError(`store file ${file} is not a regular file`)
    if (stat.mode & 0o077) fs.fchmodSync(fd, 0o600)
  } finally {
    fs.closeSync(fd)
  }
}

/** Creates the store file 0600 if it's missing, else tightens it to 0600; throws `StoreError` if the path
 *  is anything but a regular file (a symlink is never followed). */
function createStoreFile(file: string): void {
  const { O_CREAT, O_EXCL, O_NOFOLLOW, O_RDWR } = fs.constants
  try {
    fs.closeSync(fs.openSync(file, O_CREAT | O_EXCL | O_NOFOLLOW | O_RDWR, 0o600))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "EEXIST" && code !== "ELOOP") throw error
    tighten(file)
  }
}

/** The office store at `path`: created 0600 in a 0700 dir, WAL mode, migrated on open. */
export class Store {
  readonly path: string
  #db: Sqlite
  #closed = false
  #tx: Tx | undefined
  #listeners: Listener[] = []
  /** Each entity table's column names, read once. */
  readonly #tableColumns = new Map<string, Set<string>>()
  /** The events still to deliver while a delivery is running, else undefined. */
  #pending: Event[] | undefined
  readonly #log: (line: string) => void

  constructor(file: string, options?: StoreOptions) {
    this.path = file
    this.#log = options?.log ?? console.error
    // Every file SQLite creates beside the store (-wal, -shm, journals) is private too.
    const old = process.umask(0o077)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      createStoreFile(file)
      for (const sidecar of ["-wal", "-shm", "-journal"]) tighten(file + sidecar)
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

  /** Calls `listener(event)` for each event after its transaction commits, in commit order. A listener's
   *  own writes are delivered after the events still being delivered. A listener that throws is logged
   *  (its error's type only) and the others still run. Returns an idempotent remover. */
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
    if (this.#pending) {
      // A listener wrote to the store: its events go after the ones still being delivered, so every
      // listener sees commit order.
      this.#pending.push(...events)
      return
    }
    const pending = (this.#pending = [...events])
    try {
      for (let event = pending.shift(); event; event = pending.shift()) {
        for (const listener of [...this.#listeners]) {
          try {
            listener(event)
          } catch (error) {
            const type = error instanceof Error ? error.name : typeof error
            // A broken log must not cost the other listeners their events, nor give the writer an error
            // after its change committed.
            try {
              this.#log(`store listener failed on ${event.type} ${event.id}: ${type}`)
            } catch {}
          }
        }
      }
    } finally {
      this.#pending = undefined
    }
  }

  // Generic row access.

  /** The row for `entity`: validated, with JSON fields as JSON text and booleans as 0/1. A field with no
   *  column (a protocol field added without a store migration) throws `StoreError`. */
  #columns<S extends z.ZodObject>(table: Table<S>, entity: z.output<S>): Record<string, SqliteParam> {
    let known = this.#tableColumns.get(table.name)
    if (!known) {
      const rows = this.db.prepare(`PRAGMA table_info(${quote(table.name)})`).all()
      known = new Set(rows.map((r) => r.name as string))
      this.#tableColumns.set(table.name, known)
    }
    // Every schema field, not just the ones given, as Python's full model dump did.
    const names = new Set([...Object.keys(table.schema.shape), ...Object.keys(entity)])
    const missing = [...names].filter((name) => !table.derived.has(name) && !known.has(name)).sort()
    if (missing.length) {
      throw new StoreError(
        `${table.name} has no column ${missing.map((name) => `'${name}'`).join(", ")} for ${table.label}; ` +
          "the field needs a store migration",
      )
    }
    const result = table.schema.safeParse(entity)
    if (!result.success) {
      throw new StoreError(`${table.name}: ${validationMessage(table.schema, result.error, entity)}`)
    }
    const cols: Record<string, SqliteParam> = {}
    for (const [name, value] of Object.entries(result.data as Record<string, unknown>)) {
      if (table.derived.has(name)) continue
      if (table.json.has(name)) cols[name] = value === null ? null : JSON.stringify(value)
      else if (table.bools.has(name)) cols[name] = value ? 1 : 0
      else cols[name] = value as SqliteParam
    }
    return cols
  }

  /** The entity in `row`, with `extra` (derived fields) merged in; throws `StoreError` if it doesn't validate. */
  #entity<S extends z.ZodObject>(table: Table<S>, row: SqliteRow, extra?: Record<string, unknown>): z.output<S> {
    const data: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(row)) {
      if (!(name in table.schema.shape)) continue
      if (table.json.has(name)) data[name] = value === null ? null : JSON.parse(value as string)
      else if (table.bools.has(name)) data[name] = value !== 0
      else data[name] = value
    }
    Object.assign(data, extra)
    const result = table.schema.safeParse(data)
    if (!result.success) throw new StoreError(`${table.name}: ${validationMessage(table.schema, result.error, data)}`)
    return result.data
  }

  /** `current` with `changes` applied, validated; throws `StoreError` if `changes` touches a `frozen` field. */
  #changed<S extends z.ZodObject>(
    table: Table<S>,
    current: z.output<S>,
    changes: Record<string, unknown>,
    frozen: string[],
  ): z.output<S> {
    const bad = frozen.filter((name) => name in changes).sort()
    if (bad.length) throw new StoreError(`cannot change ${JSON.stringify(bad)} this way`)
    const data = { ...current, ...changes }
    const result = table.schema.safeParse(data)
    if (!result.success) throw new StoreError(`${table.name}: ${validationMessage(table.schema, result.error, data)}`)
    return result.data
  }

  // Sessions, their runs, worked folders.

  #session(row: SqliteRow): SessionRecord {
    const runs = this.db.prepare("SELECT run_id FROM session_runs WHERE session_id = ? ORDER BY seq").all(row.id!)
    return this.#entity(SESSIONS, row, { run_ids: runs.map((r) => r.run_id) })
  }

  #mustSession(sessionId: string): SessionRecord {
    const found = this.getSession(sessionId)
    if (!found) throw new NotFound(`no session ${sessionId}`)
    return found
  }

  #insertRun(tx: Tx, sessionId: string, runId: string): void {
    try {
      tx.run(
        "INSERT INTO session_runs (session_id, run_id, seq) " +
          "VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM session_runs WHERE session_id = ?))",
        sessionId,
        runId,
        sessionId,
      )
    } catch (error) {
      const code = sqliteErrorCode(error)
      if (code === 2067 || code === 1555) throw new DuplicateKey(`run ${runId} already belongs to a session`)
      if (code === 787) throw new NotFound(`no session ${sessionId}`)
      throw error
    }
  }

  /** Inserts a session (and its `run_ids`) and emits `session.created`. */
  createSession(session: SessionRecord): SessionRecord {
    return this.transaction((tx) => {
      tx.insert(SESSIONS.name, this.#columns(SESSIONS, session))
      for (const runId of session.run_ids) this.#insertRun(tx, session.id, runId)
      const stored = this.#mustSession(session.id)
      tx.emit("session.created", session.id, stored)
      return stored
    })
  }

  /** The session with its runs, or undefined. */
  getSession(sessionId: string): SessionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId)
    return row && this.#session(row)
  }

  /** Sessions, most recently updated first, optionally filtered (`cwd` is the folder's resolved path). */
  listSessions(filter?: {
    person?: string
    status?: string | string[]
    kind?: string
    cwd?: string
    limit?: number
  }): SessionRecord[] {
    const clauses: string[] = []
    const params: SqliteParam[] = []
    const where = { person: filter?.person, status: filter?.status, kind: filter?.kind, cwd: filter?.cwd }
    for (const [name, value] of Object.entries(where)) {
      if (value === undefined) continue
      if (Array.isArray(value)) {
        clauses.push(`${quote(name)} IN (${value.map(() => "?").join(", ")})`)
        params.push(...value)
      } else {
        clauses.push(`${quote(name)} = ?`)
        params.push(value)
      }
    }
    const sql =
      `SELECT * FROM sessions${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ` +
      "ORDER BY updated_at DESC, rowid DESC LIMIT ?"
    return this.db
      .prepare(sql)
      .all(...params, filter?.limit ?? -1)
      .map((row) => this.#session(row))
  }

  /** A person's sessions, most recently updated first. */
  recentSessions(person: string, limit = 20): SessionRecord[] {
    return this.listSessions({ person, limit })
  }

  /** The session a run belongs to, or undefined. */
  sessionForRun(runId: string): SessionRecord | undefined {
    const row = this.db.prepare("SELECT session_id FROM session_runs WHERE run_id = ?").get(runId)
    return row && this.getSession(row.session_id as string)
  }

  /** Changes fields of a session and emits `session.updated` (`updated_at` defaults to now). */
  updateSession(sessionId: string, changes: Partial<SessionRecord>): SessionRecord {
    return this.transaction((tx) => {
      const current = this.#mustSession(sessionId)
      const session = this.#changed(SESSIONS, current, { updated_at: now(), ...changes }, [
        "id",
        "run_ids",
        "created_at",
      ])
      tx.update(SESSIONS.name, SESSIONS.key, this.#columns(SESSIONS, session))
      const stored = this.#mustSession(sessionId)
      tx.emit("session.updated", sessionId, stored)
      return stored
    })
  }

  /** Appends a run to a session and emits `session.updated`. */
  addSessionRun(sessionId: string, runId: string): SessionRecord {
    return this.transaction((tx) => {
      this.#mustSession(sessionId)
      this.#insertRun(tx, sessionId, runId)
      tx.run("UPDATE sessions SET updated_at = ? WHERE id = ?", now(), sessionId)
      const stored = this.#mustSession(sessionId)
      tx.emit("session.updated", sessionId, stored)
      return stored
    })
  }

  /** Records that `person` worked in `cwd` at `at` (default now). */
  touchWorkedFolder(person: string, cwd: string, at?: string): void {
    this.transaction((tx) =>
      tx.run(
        "INSERT INTO worked_folders (person, cwd, last_at) VALUES (?, ?, ?) " +
          "ON CONFLICT (person, cwd) DO UPDATE SET last_at = excluded.last_at",
        person,
        cwd,
        at ?? now(),
      ),
    )
  }

  /** A person's folders, most recent first. */
  workedFolders(person: string, limit = 20): WorkedFolder[] {
    return this.db
      .prepare("SELECT cwd, last_at FROM worked_folders WHERE person = ? ORDER BY last_at DESC, cwd LIMIT ?")
      .all(person, limit)
      .map((r) => ({ cwd: r.cwd as string, lastAt: r.last_at as string }))
  }

  // Runs: the office's own facts, no events (yian's run log holds the rest).

  /** Inserts a launched run with no end; an unknown session → NotFound, a repeated run id → DuplicateKey. */
  addRun(row: Omit<RunRow, "endReason" | "endedAt">): RunRow {
    const run: RunRow = { ...row, endReason: null, endedAt: null }
    this.transaction((tx) =>
      tx.insert("runs", {
        run_id: run.runId,
        session_id: run.sessionId,
        driver: run.driver,
        flow: run.flow,
        flow_path: run.flowPath,
        connection: run.connection,
        model: run.model,
        config_sha256: run.configSha256,
        end_reason: null,
        ended_at: null,
        replaces_run_id: run.replacesRunId,
        created_at: run.createdAt,
      }),
    )
    return run
  }

  /** Records the connection, model and config hash a run was started on (set at spawn). */
  setRunConfig(
    runId: string,
    config: { connection: string | null; model: string | null; configSha256: string | null },
  ): void {
    this.transaction((tx) =>
      tx.run(
        "UPDATE runs SET connection = ?, model = ?, config_sha256 = ? WHERE run_id = ?",
        config.connection,
        config.model,
        config.configSha256,
        runId,
      ),
    )
  }

  /** Writes the office's end reason (cut to REASON_KEPT; ended now or at `at`) unless the run has one; returns
   *  whether it wrote. */
  endRun(runId: string, reason: string, at?: string): boolean {
    const row = this.transaction((tx) =>
      tx.get(
        "UPDATE runs SET end_reason = ?, ended_at = ? WHERE run_id = ? AND end_reason IS NULL RETURNING run_id",
        cutReason(reason, REASON_KEPT),
        at ?? now(),
        runId,
      ),
    )
    return row !== undefined
  }

  /** Gives each listed run that has a row and no end reason the end reason `reason` and no end time; returns
   *  the ids it wrote, in run-id order. The caller picks the runs (yian's index knows which ended). */
  sweepRuns(runIds: Iterable<string>, reason: string): string[] {
    const ids = [...new Set(runIds)].sort()
    const sql = "UPDATE runs SET end_reason = ? WHERE run_id = ? AND end_reason IS NULL RETURNING run_id"
    return this.transaction((tx) => {
      const written: string[] = []
      for (const runId of ids) if (tx.get(sql, reason, runId) !== undefined) written.push(runId)
      return written
    })
  }

  /** The run's row, or undefined. */
  getRun(runId: string): RunRow | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId)
    return row && runRow(row)
  }

  /** The rows of those of `runIds` that have one, by run id. */
  getRuns(runIds: Iterable<string>): Map<string, RunRow> {
    // One JSON parameter rather than a `?` per id: a long list would pass SQLite's variable limit.
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE run_id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify([...runIds]))
    return new Map(rows.map((r) => [r.run_id as string, runRow(r)]))
  }

  /** A session's rows, oldest first. */
  runsOfSession(sessionId: string): RunRow[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE session_id = ? ORDER BY created_at, run_id")
      .all(sessionId)
      .map(runRow)
  }

  /** The summed price of a run's model calls. */
  runUsageUsd(runId: string): number {
    return this.db.prepare("SELECT COALESCE(SUM(usd), 0) AS usd FROM usage WHERE run_id = ?").get(runId)!.usd as number
  }

  // Audit, usage, workers: office bookkeeping, no events.

  /** Appends an audit row. `args` must already be redacted. */
  recordAudit(entry: {
    person: string
    kind: string
    tool: string
    args: Record<string, unknown>
    outcome: string
    sessionId?: string | null
    runId?: string | null
    detail?: string | null
  }): AuditEntry {
    const at = now()
    const { person, kind, tool, args, outcome } = entry
    const sessionId = entry.sessionId ?? null
    const runId = entry.runId ?? null
    const detail = entry.detail ?? null
    const row = this.transaction((tx) =>
      tx.get(
        "INSERT INTO audit (at, person, session_id, run_id, kind, tool, args, outcome, detail) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        at,
        person,
        sessionId,
        runId,
        kind,
        tool,
        JSON.stringify(args),
        outcome,
        detail,
      ),
    )!
    return { id: row.id as number, at, person, kind, tool, args, outcome, sessionId, runId, detail }
  }

  /** Audit rows in the order they were written, optionally filtered. */
  listAudit(filter?: { sessionId?: string; person?: string }): AuditEntry[] {
    const clauses: string[] = []
    const params: string[] = []
    if (filter?.sessionId !== undefined) {
      clauses.push("session_id = ?")
      params.push(filter.sessionId)
    }
    if (filter?.person !== undefined) {
      clauses.push("person = ?")
      params.push(filter.person)
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""
    return this.db
      .prepare(`SELECT * FROM audit${where} ORDER BY id`)
      .all(...params)
      .map((r) => ({
        id: r.id as number,
        at: r.at as string,
        person: r.person as string,
        kind: r.kind as string,
        tool: r.tool as string,
        args: JSON.parse(r.args as string) as Record<string, unknown>,
        outcome: r.outcome as string,
        sessionId: r.session_id as string | null,
        runId: r.run_id as string | null,
        detail: r.detail as string | null,
      }))
  }

  /** Appends the price of one model call. */
  recordUsage(usage: { sessionId: string; runId: string; model: string; usd: number }): UsageRecord {
    const at = now()
    const { sessionId, runId, model, usd } = usage
    const row = this.transaction((tx) =>
      tx.get(
        "INSERT INTO usage (at, session_id, run_id, model, usd) VALUES (?, ?, ?, ?, ?) RETURNING id",
        at,
        sessionId,
        runId,
        model,
        usd,
      ),
    )!
    return { id: row.id as number, at, sessionId, runId, model, usd }
  }

  /** A session's usage rows in the order they were written. */
  listUsage(sessionId: string): UsageRecord[] {
    return this.db
      .prepare("SELECT * FROM usage WHERE session_id = ? ORDER BY id")
      .all(sessionId)
      .map((r) => ({
        id: r.id as number,
        at: r.at as string,
        sessionId: r.session_id as string,
        runId: r.run_id as string,
        model: r.model as string,
        usd: r.usd as number,
      }))
  }

  /** The summed price of a session's model calls. */
  sessionUsageUsd(sessionId: string): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(usd), 0) AS usd FROM usage WHERE session_id = ?").get(sessionId)
    return row!.usd as number
  }

  /** Spend per person since `since` (a Timestamp): priced usage, and harness sessions updated since then.
   *
   *  Only composer sessions record priced usage; a Codex or Claude session's tokens aren't priced, so it is
   *  counted instead. `unpriced_sessions` counts harness sessions whose `updated_at` is at or after `since`,
   *  which any update moves (a status change, a rename), so a counted session may not have spent anything since
   *  then. Every session kind counts: all of it is real spend. */
  costsSince(since: string): z.output<typeof CostReport> {
    const usd = new Map<string, number>()
    const count = new Map<string, number>()
    const priced = this.db
      .prepare(
        "SELECT s.person, SUM(u.usd) AS usd FROM usage u JOIN sessions s ON s.id = u.session_id " +
          "WHERE u.at >= ? GROUP BY s.person",
      )
      .all(since)
    for (const r of priced) usd.set(r.person as string, r.usd as number)
    const unpriced = this.db
      .prepare(
        "SELECT person, COUNT(*) AS n FROM sessions WHERE harness != 'composer' AND updated_at >= ? GROUP BY person",
      )
      .all(since)
    for (const r of unpriced) count.set(r.person as string, r.n as number)
    const people: z.output<typeof CostReport>["people"] = {}
    for (const person of [...new Set([...usd.keys(), ...count.keys()])].sort()) {
      people[person] = { usd: usd.get(person) ?? 0, unpriced_sessions: count.get(person) ?? 0 }
    }
    return { since, people }
  }

  /** Records the process under `key`, replacing any earlier record for the key (which keeps its place). */
  recordWorker(key: string, worker: { pid: number; pgid: number; startTime: number }): WorkerRecord {
    const { pid, pgid, startTime } = worker
    this.transaction((tx) =>
      tx.run(
        "INSERT INTO workers (key, pid, pgid, start_time) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT (key) DO UPDATE SET pid = excluded.pid, pgid = excluded.pgid, start_time = excluded.start_time",
        key,
        pid,
        pgid,
        startTime,
      ),
    )
    return { key, pid, pgid, startTime }
  }

  /** Every recorded worker, in the order their keys were first recorded. */
  listWorkers(): WorkerRecord[] {
    return this.db
      .prepare("SELECT * FROM workers ORDER BY rowid")
      .all()
      .map((r) => ({
        key: r.key as string,
        pid: r.pid as number,
        pgid: r.pgid as number,
        startTime: r.start_time as number,
      }))
  }

  /** Forgets the worker under `key` (a no-op when none is recorded); with `pid`, only if the record is that
   *  process's. */
  removeWorker(key: string, pid?: number): void {
    this.transaction((tx) => {
      if (pid === undefined) tx.run("DELETE FROM workers WHERE key = ?", key)
      else tx.run("DELETE FROM workers WHERE key = ? AND pid = ?", key, pid)
    })
  }

  /** Closes the connection; a second call does nothing. Throws `StoreError` inside a transaction. */
  close(): void {
    if (this.#closed) return
    if (this.#tx) throw new StoreError("the store can't close inside a transaction")
    this.#closed = true
    this.#db.close()
  }
}

/** The office's SQLite store: opening the database, 0600, in WAL mode, migrated; synchronous write
 *  transactions whose events reach listeners after the commit. */
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { inspect } from "node:util"
import {
  openSqlite,
  sqliteErrorCode,
  type Sqlite,
  type SqliteParam,
  type SqliteRow,
  type SqliteStatement,
} from "@ngocbh/yian/platform"
import {
  BrowserSession,
  Comment,
  CostReport,
  Event,
  Question,
  Session,
  WorkItem,
  now,
  validationMessage,
} from "@opencorp/protocol"
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

/** A status change the entity's state machine doesn't allow. */
export class InvalidTransition extends StoreError {
  override name = "InvalidTransition"
}

/** A work item update was based on an older version. */
export class StaleVersion extends StoreError {
  override name = "StaleVersion"

  constructor(
    readonly expected: number,
    readonly current: number,
  ) {
    super(`based on version ${expected}, current is ${current}`)
  }
}

/** A stored work item, defaults filled. */
export type WorkItemRecord = z.output<typeof WorkItem>

/** A stored comment, defaults filled. */
export type CommentRecord = z.output<typeof Comment>

/** A folder a person has had a session in, for the picker. */
export interface WorkedFolder {
  cwd: string
  lastAt: string
}

/** A stored session, defaults filled. */
export type SessionRecord = z.output<typeof Session>

/** A stored question, defaults filled. */
export type QuestionRecord = z.output<typeof Question>

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

const WORK_ITEMS: Table<typeof WorkItem> = {
  name: "work_items",
  label: "WorkItem",
  key: "id",
  schema: WorkItem,
  json: new Set(["groups"]),
  bools: new Set(["gate"]),
  derived: new Set(),
}

const COMMENTS: Table<typeof Comment> = {
  name: "comments",
  label: "Comment",
  key: "id",
  schema: Comment,
  json: new Set(),
  bools: new Set(),
  derived: new Set(),
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

const QUESTIONS: Table<typeof Question> = {
  name: "questions",
  label: "Question",
  key: "id",
  schema: Question,
  json: new Set(["options", "questions", "answer_schema", "discussion", "answer"]),
  bools: new Set(["gate"]),
  derived: new Set(),
}

/** The statuses whose question keeps its answer. */
const ANSWERED = new Set(["answered", "consumed"])
/** The status moves a question may make. */
const QUESTION_MOVES: Record<string, string[]> = { open: ["answered", "stale"], answered: ["consumed"] }

/** Throws `InvalidTransition` unless `moves` lets a `kind` go from `from` to `to`. */
function checkMove(kind: string, moves: Record<string, string[]>, from: string, to: string): void {
  if (!moves[from]?.includes(to)) throw new InvalidTransition(`${kind} cannot move from ${from} to ${to}`)
}

/** `name` quoted as an SQL identifier (a column may be a keyword, like `groups`). */
function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** `changes` without its undefined entries: an explicit undefined changes nothing. */
function defined(changes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined))
}

/** The JSON in column `name` of `table`; throws `StoreError` if it isn't valid JSON. */
function parseJson(table: string, name: string, text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // The parser's message quotes the text, which could hold a secret.
    throw new StoreError(`${table}: ${name} isn't valid JSON`)
  }
}

/** `value` as JSON text for column `name` of `table`; throws `StoreError` if it can't be stored as JSON. */
function jsonText(table: string, name: string, value: unknown): string {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch {
    // The serializer's or a toJSON's message could quote the value, which could hold a secret.
    throw new StoreError(`${table}: ${name} can't be stored as JSON`)
  }
  // A function, a symbol or a toJSON returning undefined gives undefined, which would bind as SQL NULL.
  if (text === undefined) throw new StoreError(`${table}: ${name} can't be stored as JSON`)
  return text
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

/** A browser signed in to HQ, as stored: with its secret's sha256 and its password fingerprint, which never
 *  print (inspect and JSON leave them out; they stay public readonly fields so equality checks see them). Expiry
 *  compares as text: every time comes from now(). */
export class HqSessionRecord {
  readonly id: string
  readonly person: string
  readonly name: string
  readonly label: string | null
  readonly secretSha256: string
  readonly passwordFp: string
  readonly issuedBy: string
  readonly via: z.output<typeof BrowserSession>["via"]
  readonly createdAt: string
  readonly expiresAt: string
  readonly lastUsedAt: string | null

  constructor(fields: {
    id: string
    person: string
    name: string
    label: string | null
    secretSha256: string
    passwordFp: string
    issuedBy: string
    via: z.output<typeof BrowserSession>["via"]
    createdAt: string
    expiresAt: string
    lastUsedAt: string | null
  }) {
    this.id = fields.id
    this.person = fields.person
    this.name = fields.name
    this.label = fields.label
    this.secretSha256 = fields.secretSha256
    this.passwordFp = fields.passwordFp
    this.issuedBy = fields.issuedBy
    this.via = fields.via
    this.createdAt = fields.createdAt
    this.expiresAt = fields.expiresAt
    this.lastUsedAt = fields.lastUsedAt
  }

  /** The session as the API shows it: never the secret's hash or the fingerprint. */
  public(): z.output<typeof BrowserSession> {
    return {
      id: this.id,
      person: this.person,
      name: this.name,
      label: this.label,
      via: this.via,
      issued_by: this.issuedBy,
      created_at: this.createdAt,
      expires_at: this.expiresAt,
      last_used_at: this.lastUsedAt,
    }
  }

  /** The public form, so a serialized record never carries the secret's hash or the fingerprint. */
  toJSON(): object {
    return this.public()
  }

  /** The record without the secret's hash or the fingerprint, so a logged or printed one never carries them. */
  [inspect.custom](): string {
    const { id, person, name, label, issuedBy, via, createdAt, expiresAt, lastUsedAt } = this
    return `HqSessionRecord ${inspect({ id, person, name, label, issuedBy, via, createdAt, expiresAt, lastUsedAt })}`
  }
}

/** The browser session in an `hq_sessions` row. */
function hqSessionRecord(r: SqliteRow): HqSessionRecord {
  return new HqSessionRecord({
    id: r.id as string,
    person: r.person as string,
    name: r.name as string,
    label: r.label as string | null,
    secretSha256: r.secret_sha256 as string,
    passwordFp: r.password_fp as string,
    issuedBy: r.issued_by as string,
    via: r.via as HqSessionRecord["via"],
    createdAt: r.created_at as string,
    expiresAt: r.expires_at as string,
    lastUsedAt: r.last_used_at as string | null,
  })
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
      if (table.json.has(name)) cols[name] = value === null ? null : jsonText(table.name, name, value)
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
      if (table.json.has(name)) data[name] = value === null ? null : parseJson(table.name, name, value as string)
      else if (table.bools.has(name)) data[name] = value === null ? null : value !== 0
      else data[name] = value
    }
    Object.assign(data, extra)
    const result = table.schema.safeParse(data)
    if (!result.success) throw new StoreError(`${table.name}: ${validationMessage(table.schema, result.error, data)}`)
    return result.data
  }

  /** The row of `table` whose key is `key`, as an entity, or undefined. */
  #get<S extends z.ZodObject>(table: Table<S>, key: string): z.output<S> | undefined {
    const row = this.db.prepare(`SELECT * FROM ${quote(table.name)} WHERE ${quote(table.key)} = ?`).get(key)
    return row && this.#entity(table, row)
  }

  /** The row of `table` whose key is `key`, as an entity; throws `NotFound` if there is none. */
  #must<S extends z.ZodObject>(table: Table<S>, key: string): z.output<S> {
    const found = this.#get(table, key)
    if (!found) throw new NotFound(`no ${table.name} row ${key}`)
    return found
  }

  /** The rows of `table` matching `where` (an undefined or null value is no filter, an array is any of its
   *  values), in `order`, at most `limit`, as entities. */
  #list<S extends z.ZodObject>(
    table: Table<S>,
    where: Record<string, string | string[] | null | undefined>,
    order: string,
    limit?: number,
  ): z.output<S>[] {
    const clauses: string[] = []
    const params: SqliteParam[] = []
    for (const [name, value] of Object.entries(where)) {
      if (value === undefined || value === null) continue
      if (Array.isArray(value)) {
        // One JSON parameter rather than a `?` per value: a long list would pass SQLite's variable limit.
        clauses.push(`${quote(name)} IN (SELECT value FROM json_each(?))`)
        params.push(JSON.stringify(value))
      } else {
        clauses.push(`${quote(name)} = ?`)
        params.push(value)
      }
    }
    const sql =
      `SELECT * FROM ${quote(table.name)}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ` +
      `ORDER BY ${order} LIMIT ?`
    return this.db
      .prepare(sql)
      .all(...params, limit ?? -1)
      .map((row) => this.#entity(table, row))
  }

  /** `current` with `changes` applied (undefined entries skipped), validated; throws `StoreError` if `changes`
   *  touches a `frozen` field. */
  #changed<S extends z.ZodObject>(
    table: Table<S>,
    current: z.output<S>,
    changes: Record<string, unknown>,
    frozen: string[],
  ): z.output<S> {
    changes = defined(changes)
    const bad = frozen.filter((name) => name in changes).sort()
    if (bad.length) throw new StoreError(`cannot change ${JSON.stringify(bad)} this way`)
    const data = { ...current, ...changes }
    const result = table.schema.safeParse(data)
    if (!result.success) throw new StoreError(`${table.name}: ${validationMessage(table.schema, result.error, data)}`)
    return result.data
  }

  // Work items and comments.

  /** Inserts a work item and emits `work_item.created`. */
  createWorkItem(item: WorkItemRecord): WorkItemRecord {
    return this.transaction((tx) => {
      tx.insert(WORK_ITEMS.name, this.#columns(WORK_ITEMS, item))
      const stored = this.#must(WORK_ITEMS, item.id)
      tx.emit("work_item.created", item.id, stored)
      return stored
    })
  }

  /** The work item, or undefined. */
  getWorkItem(itemId: string): WorkItemRecord | undefined {
    return this.#get(WORK_ITEMS, itemId)
  }

  /** Work items, newest first, optionally filtered. */
  listWorkItems(filter?: { assignee?: string; status?: string | string[]; limit?: number }): WorkItemRecord[] {
    return this.#list(
      WORK_ITEMS,
      { assignee: filter?.assignee, status: filter?.status },
      "created_at DESC, rowid DESC",
      filter?.limit,
    )
  }

  /** Changes fields of a work item, bumps its version and emits `work_item.updated` (`updated_at` defaults to
   *  now). With `baseVersion`, a work item at another version throws `StaleVersion`. */
  updateWorkItem(itemId: string, changes: Partial<WorkItemRecord>, baseVersion?: number): WorkItemRecord {
    return this.transaction((tx) => {
      const current = this.#must(WORK_ITEMS, itemId)
      if (baseVersion !== undefined && baseVersion !== current.version) {
        throw new StaleVersion(baseVersion, current.version)
      }
      const changed = this.#changed(WORK_ITEMS, current, { updated_at: now(), ...defined(changes) }, [
        "id",
        "version",
        "created_at",
      ])
      const item = { ...changed, version: current.version + 1 }
      tx.update(WORK_ITEMS.name, WORK_ITEMS.key, this.#columns(WORK_ITEMS, item))
      const stored = this.#must(WORK_ITEMS, itemId)
      tx.emit("work_item.updated", itemId, stored)
      return stored
    })
  }

  /** Inserts a comment and emits `comment.created`; a missing work item → NotFound. */
  addComment(comment: CommentRecord): CommentRecord {
    return this.transaction((tx) => {
      tx.insert(COMMENTS.name, this.#columns(COMMENTS, comment))
      const stored = this.#must(COMMENTS, comment.id)
      tx.emit("comment.created", comment.id, stored)
      return stored
    })
  }

  /** A work item's comments, oldest first. */
  listComments(workItemId: string): CommentRecord[] {
    return this.#list(COMMENTS, { work_item_id: workItemId }, "created_at, rowid")
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
      const session = this.#changed(SESSIONS, current, { updated_at: now(), ...defined(changes) }, [
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

  /** Records the connection, model and config hash a run was started on (set at spawn); an unknown run →
   *  NotFound. */
  setRunConfig(
    runId: string,
    config: { connection: string | null; model: string | null; configSha256: string | null },
  ): void {
    const row = this.transaction((tx) =>
      tx.get(
        "UPDATE runs SET connection = ?, model = ?, config_sha256 = ? WHERE run_id = ? RETURNING run_id",
        config.connection,
        config.model,
        config.configSha256,
        runId,
      ),
    )
    if (row === undefined) throw new NotFound(`no run ${runId}`)
  }

  /** Writes the office's end reason (cut to REASON_KEPT; ended now or at `at`) unless the run has one; returns
   *  whether it wrote.
   *
   *  It records an end the office decided. Callers must not call it for a run whose end yian recorded (a
   *  finished, failed or stopped run): in the run status rule the office's end reason wins over yian's status,
   *  so it would hide yian's outcome. Write-once only stops a second office end. */
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
    const kept = cutReason(reason, REASON_KEPT)
    return this.transaction((tx) => {
      const written: string[] = []
      for (const runId of ids) if (tx.get(sql, kept, runId) !== undefined) written.push(runId)
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

  /** The rows with no end reason, by run id. */
  openRuns(): RunRow[] {
    return this.db.prepare("SELECT * FROM runs WHERE end_reason IS NULL ORDER BY run_id").all().map(runRow)
  }

  /** A page of rows, newest first, after run `before` when given and at most `limit`: the top-level ones (not a
   *  child in `links`, which maps a child run id to its parent's), or `parent`'s linked children. With a launch
   *  range (`since` inclusive, `until` exclusive), only rows launched in it; with `recent`, only rows open (no end
   *  reason and not in `ended`, the runs yian ended) or launched at or after it. A top-level row is also on the
   *  page when a linked child of it is. A launch range with `recent` throws. */
  runPage(query: {
    before: string | null
    limit: number
    parent: string | null
    links: ReadonlyMap<string, string>
    since?: string | null
    until?: string | null
    recent?: string | null
    ended?: Iterable<string>
  }): RunRow[] {
    const { since = null, until = null, recent = null } = query
    const ranged = since !== null || until !== null
    if (ranged && recent !== null) throw new Error("a launch range and recent can't be combined")
    // `links` and `ended` are each one JSON parameter rather than a `?` per id: a long list would pass SQLite's
    // variable limit.
    const params: SqliteParam[] = [
      JSON.stringify(Object.fromEntries(query.links)),
      JSON.stringify([...(query.ended ?? [])]),
    ]
    // The filter on row alias `r`; it pushes its binds as it is built, so fragments are built in SQL text order.
    // '' sorts before every Timestamp and '~' after every ULID and Timestamp, so a missing bound keeps every row.
    const kept = (r: string) => {
      if (ranged) {
        params.push(since, until)
        return `(${r}.created_at >= COALESCE(?, '') AND ${r}.created_at < COALESCE(?, '~'))`
      }
      params.push(recent)
      return `((${r}.end_reason IS NULL AND ${r}.run_id NOT IN (SELECT run_id FROM ended)) OR ${r}.created_at >= ?)`
    }
    let where: string
    if (query.parent !== null) {
      params.push(query.parent)
      where = "r.run_id IN (SELECT child FROM link WHERE parent = ?)"
      if (ranged || recent !== null) where += ` AND ${kept("r")}`
    } else {
      where = "r.run_id NOT IN (SELECT child FROM link)"
      if (ranged || recent !== null) {
        const self = kept("r")
        const child = kept("c")
        where += ` AND (${self} OR r.run_id IN (SELECT link.parent FROM link JOIN runs c ON c.run_id = link.child ` +
          `WHERE ${child}))`
      }
    }
    params.push(query.before, query.limit)
    const sql =
      "WITH link AS (SELECT key AS child, value AS parent FROM json_each(?)), " +
      "ended AS (SELECT value AS run_id FROM json_each(?)) " +
      `SELECT r.* FROM runs r WHERE ${where} AND r.run_id < COALESCE(?, '~') ORDER BY r.run_id DESC LIMIT ?`
    return this.db.prepare(sql).all(...params).map(runRow)
  }

  /** The rows of those of `runIds` that have one, newest first: only those launched in the range when given
   *  (`since` inclusive, `until` exclusive), open (no end reason and not in `ended`, the runs yian ended) or
   *  launched at or after `recent` when given, and open when `openOnly`. */
  runsAmong(
    runIds: Iterable<string>,
    filters: {
      since?: string | null
      until?: string | null
      recent?: string | null
      ended?: Iterable<string>
      openOnly?: boolean
    } = {},
  ): RunRow[] {
    const { since = null, until = null, recent = null } = filters
    // One JSON parameter per list rather than a `?` per id: a long list would pass SQLite's variable limit.
    const params: SqliteParam[] = [JSON.stringify([...(filters.ended ?? [])]), JSON.stringify([...runIds])]
    const open = "(end_reason IS NULL AND run_id NOT IN (SELECT run_id FROM ended))"
    let where = "run_id IN (SELECT value FROM json_each(?))"
    if (since !== null || until !== null) {
      where += " AND created_at >= COALESCE(?, '') AND created_at < COALESCE(?, '~')"
      params.push(since, until)
    }
    if (recent !== null) {
      where += ` AND (${open} OR created_at >= ?)`
      params.push(recent)
    }
    if (filters.openOnly) where += ` AND ${open}`
    const sql =
      "WITH ended AS (SELECT value AS run_id FROM json_each(?)) " +
      `SELECT * FROM runs WHERE ${where} ORDER BY run_id DESC`
    return this.db.prepare(sql).all(...params).map(runRow)
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

  // Questions.

  #questionColumns(question: QuestionRecord): Record<string, SqliteParam> {
    const cols = this.#columns(QUESTIONS, question)
    // SQL NULL means "not answered"; an answered question stores its answer as JSON, which may be the text
    // `null`. An open or stale question keeps no answer fields.
    if (ANSWERED.has(question.status)) cols.answer = jsonText(QUESTIONS.name, "answer", question.answer ?? null)
    else Object.assign(cols, { answer: null, answer_kind: null, answered_by: null })
    return cols
  }

  /** Inserts a question and emits `question.created`. A second question with the same `call_id`, or the same
   *  `(run_id, node_id)`, throws `DuplicateKey`; questions with a null `call_id` or `node_id` never collide. */
  addQuestion(question: QuestionRecord): QuestionRecord {
    return this.transaction((tx) => {
      tx.insert(QUESTIONS.name, this.#questionColumns(question))
      const stored = this.#must(QUESTIONS, question.id)
      tx.emit("question.created", question.id, stored)
      return stored
    })
  }

  /** The question, or undefined. `answer` is null until the question is answered. */
  getQuestion(questionId: string): QuestionRecord | undefined {
    return this.#get(QUESTIONS, questionId)
  }

  /** The `ask` node question stored for a run's node, or undefined. */
  getQuestionByNode(runId: string, nodeId: string): QuestionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM questions WHERE run_id = ? AND node_id = ?").get(runId, nodeId)
    return row && this.#entity(QUESTIONS, row)
  }

  /** The question stored for a yian call id, or undefined. */
  getQuestionByCall(callId: string): QuestionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM questions WHERE call_id = ?").get(callId)
    return row && this.#entity(QUESTIONS, row)
  }

  /** Questions, oldest first, optionally filtered (by any of several run ids or statuses). */
  listQuestions(filter?: {
    sessionId?: string
    runId?: string | string[]
    status?: string | string[]
    source?: string
  }): QuestionRecord[] {
    const where = {
      session_id: filter?.sessionId,
      run_id: filter?.runId,
      status: filter?.status,
      source: filter?.source,
    }
    return this.#list(QUESTIONS, where, "created_at, rowid")
  }

  #writeQuestion(tx: Tx, question: QuestionRecord): QuestionRecord {
    tx.update(QUESTIONS.name, QUESTIONS.key, this.#questionColumns(question))
    const stored = this.#must(QUESTIONS, question.id)
    tx.emit("question.updated", question.id, stored)
    return stored
  }

  /** Answers an open question and emits `question.updated`; the answer is stored as its JSON form. The first
   *  answer wins: answering a question that is not open throws `InvalidTransition`. */
  answerQuestion(
    questionId: string,
    answer: unknown,
    answerKind: NonNullable<QuestionRecord["answer_kind"]>,
    answeredBy?: string | null,
  ): QuestionRecord {
    return this.transaction((tx) => {
      const current = this.#must(QUESTIONS, questionId)
      checkMove("question", QUESTION_MOVES, current.status, "answered")
      const question = this.#changed(
        QUESTIONS,
        current,
        { status: "answered", answer, answer_kind: answerKind, answered_by: answeredBy ?? null, updated_at: now() },
        [],
      )
      return this.#writeQuestion(tx, question)
    })
  }

  /** Moves a question to `consumed` (from answered) or `stale` (from open) and emits `question.updated`. */
  setQuestionStatus(questionId: string, status: QuestionRecord["status"]): QuestionRecord {
    if (status === "answered") throw new InvalidTransition("answer a question with answerQuestion")
    return this.transaction((tx) => {
      const current = this.#must(QUESTIONS, questionId)
      checkMove("question", QUESTION_MOVES, current.status, status)
      return this.#writeQuestion(tx, { ...current, status, updated_at: now() })
    })
  }

  /** Moves an answered question to `stale`, dropping its answer: the answer never reached the asker (a harness
   *  request that resolved, or whose process died, before the reply). Emits `question.updated`.
   *
   *  Only this move leaves `answered` for `stale`. `setQuestionStatus` never does, so a run that ends can't
   *  expire an answer that has just landed. */
  loseAnswer(questionId: string): QuestionRecord {
    return this.transaction((tx) => {
      const current = this.#must(QUESTIONS, questionId)
      if (current.status !== "answered") {
        throw new InvalidTransition(`question ${questionId} is ${current.status}, not answered`)
      }
      return this.#writeQuestion(tx, { ...current, status: "stale", updated_at: now() })
    })
  }

  /** Changes non-status fields (discussion, side_session_id, ...) and emits `question.updated` (`updated_at`
   *  defaults to now). */
  updateQuestion(questionId: string, changes: Partial<QuestionRecord>): QuestionRecord {
    return this.transaction((tx) => {
      const current = this.#must(QUESTIONS, questionId)
      const question = this.#changed(QUESTIONS, current, { updated_at: now(), ...defined(changes) }, [
        "id",
        "session_id",
        "run_id",
        "node_id",
        "call_id",
        "status",
        "answer",
        "answer_kind",
        "answered_by",
        "created_at",
      ])
      return this.#writeQuestion(tx, question)
    })
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

  // HQ browser sessions: office-local bookkeeping, no events.

  /** Inserts a browser session after deleting every one expired by its creation time; a repeated id or secret
   *  hash → DuplicateKey. */
  addHqSession(record: HqSessionRecord): void {
    this.transaction((tx) => {
      tx.run("DELETE FROM hq_sessions WHERE expires_at <= ?", record.createdAt)
      tx.insert("hq_sessions", {
        id: record.id,
        person: record.person,
        name: record.name,
        label: record.label,
        secret_sha256: record.secretSha256,
        password_fp: record.passwordFp,
        issued_by: record.issuedBy,
        via: record.via,
        created_at: record.createdAt,
        expires_at: record.expiresAt,
        last_used_at: record.lastUsedAt,
      })
    })
  }

  /** The browser session `sessionId`, or undefined. */
  getHqSession(sessionId: string): HqSessionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM hq_sessions WHERE id = ?").get(sessionId)
    return row && hqSessionRecord(row)
  }

  /** The browser session whose cookie secret hashes to `secretSha256`, unless it expired by `at`. */
  hqSessionBySecret(secretSha256: string, at: string): HqSessionRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM hq_sessions WHERE secret_sha256 = ? AND expires_at > ?")
      .get(secretSha256, at)
    return row && hqSessionRecord(row)
  }

  /** Browser sessions, newest first, optionally one person's. */
  listHqSessions(person?: string): HqSessionRecord[] {
    const where = person === undefined ? "" : " WHERE person = ?"
    return this.db
      .prepare(`SELECT * FROM hq_sessions${where} ORDER BY created_at DESC, id DESC`)
      .all(...(person === undefined ? [] : [person]))
      .map(hqSessionRecord)
  }

  /** Records that the session was used at `at`, unless it was already recorded as used since `before`. */
  touchHqSession(sessionId: string, at: string, before: string): void {
    this.transaction((tx) =>
      tx.run(
        "UPDATE hq_sessions SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)",
        at,
        sessionId,
        before,
      ),
    )
  }

  /** Deletes a browser session; returns whether there was one. */
  deleteHqSession(sessionId: string): boolean {
    const row = this.transaction((tx) => tx.get("DELETE FROM hq_sessions WHERE id = ? RETURNING id", sessionId))
    return row !== undefined
  }

  /** Deletes the sessions expired by `at`; returns how many. */
  pruneHqSessions(at: string): number {
    return this.transaction((tx) => {
      tx.run("DELETE FROM hq_sessions WHERE expires_at <= ?", at)
      return tx.get("SELECT changes() AS n")!.n as number
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

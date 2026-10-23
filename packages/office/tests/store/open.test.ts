/** Opening the store: schema, WAL, file modes. */
import fs from "node:fs"
import path from "node:path"
import { expect, onTestFinished, test } from "bun:test"
import { openSqlite, sqliteErrorCode, type SqliteStatement } from "@ngocbh/yian/platform"
import { MIGRATIONS, MigrationError, ladder, userVersion } from "../../src/store/migrate.ts"
import { Store, StoreError, enableWal } from "../../src/store/store.ts"
import { tempDir } from "../helpers.ts"
import { openStore, thrown } from "./helpers.ts"

const TABLES = new Set([
  "work_items",
  "comments",
  "sessions",
  "session_runs",
  "runs",
  "questions",
  "worked_folders",
  "audit",
  "usage",
  "workers",
  "hq_sessions",
])

/** A store at `path`, closed when the test finishes. */
function storeAt(file: string): Store {
  const store = new Store(file)
  onTestFinished(() => store.close())
  return store
}

/** The process's umask, read without changing it. */
function umask(): number {
  const u = process.umask(0o022)
  process.umask(u)
  return u
}

test("open creates every table", () => {
  const store = openStore()
  const sql = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  const rows = store.db.prepare(sql).all()
  expect(new Set(rows.map((r) => String(r.name)))).toEqual(TABLES)
})

test("open migrates to the latest file", () => {
  const store = openStore()
  expect(userVersion(store.db)).toBe(ladder(MIGRATIONS).at(-1)![0])
})

test("wal and busy timeout", () => {
  const db = openStore().db
  expect(db.prepare("PRAGMA journal_mode").get()!.journal_mode).toBe("wal")
  expect(db.prepare("PRAGMA busy_timeout").get()!.timeout as number).toBeGreaterThanOrEqual(5000)
  expect(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys).toBe(1)
  expect(db.prepare("PRAGMA synchronous").get()!.synchronous).toBe(1)
})

test("hq sessions has every column and a unique secret hash", () => {
  const db = openStore().db
  const cols = db.prepare("PRAGMA table_info(hq_sessions)").all().map((r) => r.name)
  expect(cols).toEqual([
    "id",
    "person",
    "name",
    "label",
    "secret_sha256",
    "password_fp",
    "issued_by",
    "via",
    "created_at",
    "expires_at",
    "last_used_at",
  ])
  const row = [
    "S1",
    "ngocbh",
    "web-aaaaaa",
    null,
    "h".repeat(64),
    "f".repeat(16),
    "ngocbh",
    "pair",
    "2026-10-19T10:00:00.000Z",
    "2026-11-18T10:00:00.000Z",
    null,
  ]
  const insert = db.prepare(`INSERT INTO hq_sessions VALUES (${row.map(() => "?").join(", ")})`)
  insert.run(...row)
  const e = thrown(() => insert.run("S2", ...row.slice(1)))
  expect((sqliteErrorCode(e) ?? 0) & 0xff).toBe(19)
})

test("usage is indexed by time", () => {
  const plan = openStore().db.prepare("EXPLAIN QUERY PLAN SELECT SUM(usd) FROM usage WHERE at >= ?").all("x")
  expect(plan.some((r) => String(r.detail).includes("usage_at"))).toBe(true)
})

test("reopen keeps data and version", () => {
  const file = path.join(tempDir(), "office", "store.sqlite")
  const first = storeAt(file)
  first.db.prepare("INSERT INTO worked_folders VALUES ('minh', '/w', '2026-09-29T10:00:00.000Z')").run()
  const version = userVersion(first.db)
  first.close()
  const second = storeAt(file)
  expect(second.db.prepare("SELECT cwd FROM worked_folders").all().map((r) => r.cwd)).toEqual(["/w"])
  expect(userVersion(second.db)).toBe(version)
})

test("newer store is refused", () => {
  const file = path.join(tempDir(), "s.sqlite")
  const db = openSqlite(file)
  db.exec("PRAGMA user_version = 9999")
  db.close()
  const e = thrown(() => storeAt(file))
  expect(e).toBeInstanceOf(MigrationError)
  expect((e as Error).message).toMatch(/newer/)
})

/** Answers PRAGMA journal_mode; fails the first `busy` calls with SQLITE_BUSY. */
function fakeDb(mode: string, busy = 0) {
  const fake = {
    mode,
    busy,
    sql: [] as string[],
    prepare(sql: string): Pick<SqliteStatement, "get"> {
      return {
        get() {
          fake.sql.push(sql)
          if (fake.busy) {
            fake.busy -= 1
            throw Object.assign(new Error("database is locked"), { name: "SQLiteError", errno: 5 })
          }
          if (sql === "PRAGMA journal_mode = WAL") fake.mode = "wal"
          return { journal_mode: fake.mode }
        },
      }
    },
  }
  return fake
}

test("wal is left alone when already on", () => {
  const fake = fakeDb("wal")
  enableWal(fake)
  expect(fake.sql).toEqual(["PRAGMA journal_mode"])
})

test("wal switch retries while busy", () => {
  const fake = fakeDb("delete", 3)
  enableWal(fake)
  expect(fake.mode).toBe("wal")
})

test("wal switch gives up after the timeout", () => {
  expect(() => enableWal(fakeDb("delete", 1e6), 50)).toThrow(/locked/)
})

test("the database files are 0600", () => {
  const office = path.join(tempDir(), "office")
  const file = path.join(office, "store.sqlite")
  const store = storeAt(file)
  store.db.prepare("INSERT INTO worked_folders VALUES ('minh', '/w', '2026-09-29T10:00:00.000Z')").run()
  // This pins 0600 from either protection, not each one: the pre-created 0600 file (SQLite gives -wal and -shm
  // its mode) and the umask are both active inside the constructor. Checked before close(): SQLite deletes the
  // -wal and -shm files on the last close.
  for (const f of [file, `${file}-wal`, `${file}-shm`]) expect(fs.statSync(f).mode & 0o777).toBe(0o600)
  expect(fs.statSync(office).mode & 0o777).toBe(0o700)
})

test("a symlink at the store path is refused", () => {
  const dir = tempDir()
  const office = path.join(dir, "office")
  fs.mkdirSync(office)
  const file = path.join(office, "store.sqlite")
  const elsewhere = path.join(dir, "elsewhere")

  fs.writeFileSync(elsewhere, "")
  fs.symlinkSync(elsewhere, file)
  let e = thrown(() => storeAt(file))
  expect(e).toBeInstanceOf(StoreError)
  expect((e as Error).message).toMatch(/not a regular file/)
  expect(fs.statSync(elsewhere).size).toBe(0)

  const missing = path.join(dir, "missing")
  fs.rmSync(file)
  fs.symlinkSync(missing, file)
  e = thrown(() => storeAt(file))
  expect(e).toBeInstanceOf(StoreError)
  expect((e as Error).message).toMatch(/not a regular file/)
  expect(fs.existsSync(missing)).toBe(false)

  fs.rmSync(file)
  fs.mkdirSync(file)
  e = thrown(() => storeAt(file))
  expect(e).toBeInstanceOf(StoreError)
  expect((e as Error).message).toMatch(/not a regular file/)
})

test("opening restores the umask", () => {
  const before = umask()
  onTestFinished(() => process.umask(before))
  openStore()
  expect(umask()).toBe(before)

  const dir = tempDir()
  fs.mkdirSync(path.join(dir, "office"))
  const file = path.join(dir, "office", "store.sqlite")
  fs.symlinkSync(path.join(dir, "missing"), file)
  expect(() => storeAt(file)).toThrow(StoreError)
  expect(umask()).toBe(before)
})
